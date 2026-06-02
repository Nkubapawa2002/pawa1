package main

// Nominatim gateway: the reason this service exists.
//
// Today every visitor's browser calls nominatim.openstreetmap.org directly.
// Nominatim's usage policy caps you at ~1 request/second and *requires* an
// identifying User-Agent — break it and the whole site's traffic gets the
// public IP blocked. This gateway fixes that with three stdlib-only pieces:
//
//   1. a token-bucket RATE LIMITER so we never exceed 1 req/s upstream;
//   2. an in-memory TTL CACHE so repeat lookups never leave the box;
//   3. SINGLEFLIGHT dedup so N concurrent identical queries = 1 upstream call.
//
// Net effect: thousands of browsers, one polite well-behaved upstream client.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	nominatimBase = "https://nominatim.openstreetmap.org"
	// Nominatim requires a real, contactable User-Agent.
	userAgent  = "PawaBusCargo/1.0 (https://github.com/pawa4761; map area lookups)"
	cacheTTL   = 6 * time.Hour
	upstreamRT = 8 * time.Second
)

// ---- Place: the clean shape we hand back to the frontend ------------------

type Place struct {
	Name string  `json:"name"`
	Full string  `json:"full,omitempty"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	Tag  string  `json:"tag"`
}

// ---- TTL cache ------------------------------------------------------------

type cacheEntry struct {
	val     []byte
	expires time.Time
}

type ttlCache struct {
	mu sync.RWMutex
	m  map[string]cacheEntry
}

func newTTLCache() *ttlCache { return &ttlCache{m: map[string]cacheEntry{}} }

func (c *ttlCache) get(k string) ([]byte, bool) {
	c.mu.RLock()
	e, ok := c.m[k]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	return e.val, true
}

func (c *ttlCache) set(k string, v []byte) {
	c.mu.Lock()
	c.m[k] = cacheEntry{val: v, expires: time.Now().Add(cacheTTL)}
	c.mu.Unlock()
}

// ---- token-bucket rate limiter (1 token/sec, burst 1) ---------------------

type rateLimiter struct{ tokens chan struct{} }

func newRateLimiter(perSec int) *rateLimiter {
	rl := &rateLimiter{tokens: make(chan struct{}, perSec)}
	rl.tokens <- struct{}{} // one ready immediately
	go func() {
		t := time.NewTicker(time.Second / time.Duration(perSec))
		defer t.Stop()
		for range t.C {
			select {
			case rl.tokens <- struct{}{}:
			default: // bucket full — drop the refill
			}
		}
	}()
	return rl
}

// wait blocks for a token or until ctx is cancelled.
func (rl *rateLimiter) wait(ctx context.Context) error {
	select {
	case <-rl.tokens:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ---- the gateway ----------------------------------------------------------

type geocoder struct {
	http  *http.Client
	cache *ttlCache
	rl    *rateLimiter

	// singleflight: in-flight upstream calls keyed by URL.
	flightMu sync.Mutex
	flight   map[string]*call
}

type call struct {
	wg  sync.WaitGroup
	val []byte
	err error
}

func newGeocoder() *geocoder {
	return &geocoder{
		http:   &http.Client{Timeout: upstreamRT},
		cache:  newTTLCache(),
		rl:     newRateLimiter(1), // Nominatim policy: ≤ 1 req/sec
		flight: map[string]*call{},
	}
}

// fetch returns the raw upstream body for a Nominatim URL, served from cache
// when possible, deduped across concurrent callers, and rate-limited otherwise.
func (g *geocoder) fetch(ctx context.Context, fullURL string) ([]byte, error) {
	if v, ok := g.cache.get(fullURL); ok {
		return v, nil
	}

	// Join any identical in-flight request instead of issuing a second one.
	g.flightMu.Lock()
	if c, ok := g.flight[fullURL]; ok {
		g.flightMu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &call{}
	c.wg.Add(1)
	g.flight[fullURL] = c
	g.flightMu.Unlock()

	c.val, c.err = g.doFetch(ctx, fullURL)
	if c.err == nil {
		g.cache.set(fullURL, c.val)
	}
	c.wg.Done()

	g.flightMu.Lock()
	delete(g.flight, fullURL)
	g.flightMu.Unlock()

	return c.val, c.err
}

func (g *geocoder) doFetch(ctx context.Context, fullURL string) ([]byte, error) {
	if err := g.rl.wait(ctx); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// 4 MB cap: search/reverse are tiny, but a /boundary polygon (even
	// simplified) for a district can run to a few hundred KB — don't truncate it.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream %d", resp.StatusCode)
	}
	return body, nil
}

// nominatimHit is the subset of fields we read from a search/reverse result.
type nominatimHit struct {
	Lat         string `json:"lat"`
	Lon         string `json:"lon"`
	DisplayName string `json:"display_name"`
	Class       string `json:"class"`
	Type        string `json:"type"`
	AddressType string `json:"addresstype"`
	Address     struct {
		Suburb        string `json:"suburb"`
		Neighbourhood string `json:"neighbourhood"`
		Quarter       string `json:"quarter"`
		Village       string `json:"village"`
		Hamlet        string `json:"hamlet"`
		Ward          string `json:"ward"`
		Residential   string `json:"residential"`
		CityDistrict  string `json:"city_district"`
		City          string `json:"city"`
		Town          string `json:"town"`
		Municipality  string `json:"municipality"`
		County        string `json:"county"`
		StateDistrict string `json:"state_district"`
		State         string `json:"state"`
	} `json:"address"`
}

// search → ranked, TZ-filtered, de-duplicated places (ports searchPlaces).
func (g *geocoder) search(ctx context.Context, q string, limit int) ([]Place, error) {
	q = strings.TrimSpace(q)
	if len(q) < 3 {
		return []Place{}, nil
	}
	u := fmt.Sprintf("%s/search?format=jsonv2&limit=%d&countrycodes=tz&addressdetails=1&q=%s",
		nominatimBase, limit, url.QueryEscape(q))
	body, err := g.fetch(ctx, u)
	if err != nil {
		return nil, err
	}
	var hits []nominatimHit
	if err := json.Unmarshal(body, &hits); err != nil {
		return nil, err
	}
	out := make([]Place, 0, len(hits))
	seen := map[string]bool{}
	for _, h := range hits {
		lat, lng, ok := parseLatLng(h.Lat, h.Lon)
		if !ok || !inTanzania(lat, lng) {
			continue
		}
		name := firstTwoParts(h.DisplayName)
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, Place{Name: name, Full: h.DisplayName, Lat: lat, Lng: lng, Tag: resultTag(h)})
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// reverse → friendly "nearby area" label for a tapped point (ports reverseName).
func (g *geocoder) reverse(ctx context.Context, lat, lng float64) (string, error) {
	u := fmt.Sprintf("%s/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=%f&lon=%f",
		nominatimBase, lat, lng)
	body, err := g.fetch(ctx, u)
	if err != nil {
		return "", err
	}
	var h nominatimHit
	if err := json.Unmarshal(body, &h); err != nil {
		return "", err
	}
	return placeAreaLabel(h), nil
}

// ---- label / tag helpers (ported from js/houses.js) -----------------------

// placeAreaLabel: nearest meaningful area + wider area, e.g. "Mikocheni, Kinondoni".
func placeAreaLabel(h nominatimHit) string {
	a := h.Address
	near := firstNonEmpty(a.Suburb, a.Neighbourhood, a.Quarter, a.Village, a.Hamlet, a.Ward, a.Residential, a.CityDistrict)
	wider := firstNonEmpty(a.City, a.Town, a.Municipality, a.County, a.StateDistrict, a.State)
	parts := []string{}
	for _, p := range []string{near, wider} {
		if p != "" && !contains(parts, p) {
			parts = append(parts, p)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, ", ")
	}
	return firstTwoParts(h.DisplayName)
}

var adminTag = map[string]string{
	"state": "Region", "region": "Region", "county": "District", "state_district": "District",
	"municipality": "District", "district": "District", "city": "City", "town": "Town",
	"suburb": "Suburb", "neighbourhood": "Area", "quarter": "Area", "residential": "Area",
	"village": "Village", "hamlet": "Village", "ward": "Ward", "administrative": "Area",
}

var serviceTag = map[string]string{
	"school": "School", "college": "College", "university": "University", "kindergarten": "School",
	"hospital": "Hospital", "clinic": "Clinic", "doctors": "Clinic", "pharmacy": "Pharmacy",
	"marketplace": "Market", "supermarket": "Supermarket", "mall": "Mall", "bank": "Bank", "atm": "ATM",
	"fuel": "Fuel", "bus_station": "Bus station", "taxi": "Taxi rank", "ferry_terminal": "Ferry",
	"place_of_worship": "Worship", "police": "Police", "fire_station": "Fire", "post_office": "Post",
	"restaurant": "Restaurant", "cafe": "Cafe", "hotel": "Hotel", "stadium": "Stadium",
	"airport": "Airport", "aerodrome": "Airport",
}

func resultTag(h nominatimHit) string {
	if t, ok := adminTag[strings.ToLower(h.AddressType)]; ok {
		return t
	}
	typ := strings.ToLower(h.Type)
	if t, ok := serviceTag[typ]; ok {
		return t
	}
	cls := strings.ToLower(h.Class)
	switch cls {
	case "amenity", "shop", "leisure", "tourism", "office", "healthcare", "building":
		s := typ
		if s == "" {
			s = cls
		}
		return title(strings.ReplaceAll(s, "_", " "))
	}
	return "Place"
}
