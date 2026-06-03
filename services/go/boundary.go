package main

// Administrative-boundary lookup for the map "draw the area outline" feature.
//
// When a user picks or searches an area on a houses map, the frontend wants to
// shade the actual administrative boundary it falls within (ward / suburb /
// district) instead of just dropping a pin. Nominatim can return that polygon
// via polygon_geojson=1; this endpoint fronts it with the same cache + rate
// limiter + User-Agent as the rest of the gateway, and hands back a small,
// ready-to-render shape: { name, tag, bbox:[w,s,e,n], geojson:<geometry> }.
//
//	GET /boundary?q=Mikocheni            → boundary of the named area
//	GET /boundary?lat=-6.77&lng=39.24    → boundary of the area enclosing a point
//
// polygon_threshold simplifies the outline server-side (Douglas–Peucker) so the
// payload stays light; geojson is null when the match has no polygon (e.g. a POI).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Simplification tolerance (degrees) Nominatim applies to the returned polygon.
// ~0.0008° ≈ 90 m: keeps ward/suburb shapes recognisable at city zoom while
// shrinking region-sized multipolygons enough to stay inside the fetch cap.
const polygonThreshold = "0.0008"

// boundaryHit is the subset of a Nominatim result we need for an outline.
type boundaryHit struct {
	DisplayName string          `json:"display_name"`
	Name        string          `json:"name"`
	AddressType string          `json:"addresstype"`
	Type        string          `json:"type"`
	Class       string          `json:"class"`
	BoundingBox []string        `json:"boundingbox"` // [south, north, west, east]
	GeoJSON     json.RawMessage `json:"geojson"`     // a GeoJSON geometry, or absent
}

// Boundary is the clean shape handed to the frontend.
type Boundary struct {
	Name    string          `json:"name"`
	Tag     string          `json:"tag"`
	Bbox    []float64       `json:"bbox,omitempty"` // [west, south, east, north]
	GeoJSON json.RawMessage `json:"geojson"`        // null when no polygon available
}

// boundaryByName resolves a named area to its outline (TZ-filtered).
func (g *geocoder) boundaryByName(ctx context.Context, q string) (*Boundary, error) {
	u := upstreamURL("search", fmt.Sprintf("format=jsonv2&limit=1&countrycodes=tz&addressdetails=1&polygon_geojson=1&polygon_threshold=%s&q=%s",
		polygonThreshold, url.QueryEscape(q)))
	body, err := g.fetch(ctx, u)
	if err != nil {
		return nil, err
	}
	var hits []boundaryHit
	if err := json.Unmarshal(body, &hits); err != nil {
		return nil, err
	}
	if len(hits) == 0 {
		return &Boundary{GeoJSON: json.RawMessage("null")}, nil
	}
	return toBoundary(hits[0]), nil
}

// boundaryByPoint resolves the administrative area enclosing a point to its
// outline. A plain reverse-geocode can match the nearest POI *node* (a Point,
// no outline), so we use it only to learn the area's NAME, then forward-search
// that name — which reliably returns the ward/suburb/district polygon. We try
// the narrow area first (e.g. "Mikocheni") and fall back to the wider one
// (e.g. "Kinondoni") if the narrow one has no polygon in OSM.
func (g *geocoder) boundaryByPoint(ctx context.Context, lat, lng float64) (*Boundary, error) {
	u := upstreamURL("reverse", fmt.Sprintf("format=jsonv2&zoom=16&addressdetails=1&lat=%f&lon=%f",
		lat, lng))
	body, err := g.fetch(ctx, u)
	if err != nil {
		return nil, err
	}
	var h nominatimHit
	if err := json.Unmarshal(body, &h); err != nil {
		return nil, err
	}

	near, wider := areaNames(h)
	city := firstNonEmpty(h.Address.City, h.Address.Town, h.Address.Municipality, h.Address.County)
	// Candidate names, narrowest first. Adding the city disambiguates common
	// ward names that repeat across the country.
	tried := map[string]bool{}
	for _, name := range []string{near, withCity(near, city), wider, withCity(wider, city)} {
		if name == "" || tried[name] {
			continue
		}
		tried[name] = true
		b, err := g.boundaryByName(ctx, name)
		if err == nil && hasPolygon(b.GeoJSON) {
			return b, nil
		}
	}
	// No polygon found for any enclosing area — return an empty boundary so the
	// caller cleanly shows "no outline" rather than erroring.
	return &Boundary{Name: firstNonEmpty(near, wider), GeoJSON: json.RawMessage("null")}, nil
}

func withCity(name, city string) string {
	if name == "" || city == "" || strings.EqualFold(name, city) {
		return ""
	}
	return name + ", " + city
}

// areaNames extracts the narrow ("this area") and wider ("the district") names
// from a reverse-geocode address, mirroring placeAreaLabel's hierarchy.
func areaNames(h nominatimHit) (near, wider string) {
	a := h.Address
	near = firstNonEmpty(a.Suburb, a.Neighbourhood, a.Quarter, a.Ward, a.Residential, a.Village, a.Hamlet, a.CityDistrict)
	wider = firstNonEmpty(a.CityDistrict, a.Municipality, a.County, a.City, a.Town, a.StateDistrict)
	if wider == near {
		wider = firstNonEmpty(a.Municipality, a.County, a.StateDistrict, a.State)
	}
	return near, wider
}

// hasPolygon reports whether a GeoJSON geometry is an actual area outline.
func hasPolygon(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var g struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &g) != nil {
		return false
	}
	return g.Type == "Polygon" || g.Type == "MultiPolygon"
}

func toBoundary(h boundaryHit) *Boundary {
	b := &Boundary{
		Name:    firstNonEmpty(h.Name, firstTwoParts(h.DisplayName)),
		Tag:     resultTag(nominatimHit{Class: h.Class, Type: h.Type, AddressType: h.AddressType}),
		GeoJSON: h.GeoJSON,
	}
	if len(b.GeoJSON) == 0 {
		b.GeoJSON = json.RawMessage("null")
	}
	// Nominatim boundingbox is [south, north, west, east] as strings.
	if len(h.BoundingBox) == 4 {
		s, sOK := parseFloat(h.BoundingBox[0])
		n, nOK := parseFloat(h.BoundingBox[1])
		w, wOK := parseFloat(h.BoundingBox[2])
		e, eOK := parseFloat(h.BoundingBox[3])
		if sOK && nOK && wOK && eOK {
			b.Bbox = []float64{w, s, e, n}
		}
	}
	return b
}

// handleBoundary serves GET /boundary?q=… or ?lat=&lng=.
func handleBoundary(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	latS := r.URL.Query().Get("lat")
	lngS := r.URL.Query().Get("lng")

	var (
		bnd *Boundary
		err error
	)
	switch {
	case q != "":
		if len([]rune(q)) < 3 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q too short"})
			return
		}
		bnd, err = geo.boundaryByName(r.Context(), q)
	case latS != "" && lngS != "":
		lat, okLat := parseFloat(latS)
		lng, okLng := parseFloat(lngS)
		if !okLat || !okLng {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad lat/lng"})
			return
		}
		bnd, err = geo.boundaryByPoint(r.Context(), lat, lng)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q or lat&lng required"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, bnd)
}
