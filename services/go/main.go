// Package main is the Pawa "go" service: the map area-fetching gateway.
//
// Role in the polyglot stack (see ../../docs/LANGUAGE-ROUTING.md): real-time /
// high-concurrency I/O. Geocoding is an external-API gateway — many concurrent
// browsers, one rate-limited polite upstream — which is exactly Go's lane.
//
// Endpoints (all JSON, CORS-open so the buildless static frontend can call):
//
//	GET  /health                         → liveness + role
//	GET  /geocode?q=Mlimani+City[&limit] → []Place  (TZ-filtered, cached)
//	GET  /reverse?lat=-6.77&lng=39.24    → {lat,lng,area}
//	POST /match  {places:[…], listings:[…]} → listings ranked by total commute
//
// Dependency-free: standard library only.  Run with:  go run .
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultPort = "8091"

var geo = newGeocoder()

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/geocode", handleGeocode)
	mux.HandleFunc("/reverse", handleReverse)
	mux.HandleFunc("/match", handleMatch)
	// Raw passthrough — same params & response shape as Nominatim, but cached,
	// rate-limited and User-Agent'd. Lets the existing frontend parsers swap
	// the base URL with zero parsing changes.
	mux.HandleFunc("/osm/search", handleOSM("search"))
	mux.HandleFunc("/osm/reverse", handleOSM("reverse"))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           cors(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("go map gateway listening on http://127.0.0.1:%s  (/health /geocode /reverse /match)", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// ---- handlers -------------------------------------------------------------

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"lang":   "go",
		"status": "ok",
		"role":   "map area-fetching gateway (geocode + commute match)",
		"port":   firstNonEmpty(os.Getenv("PORT"), defaultPort),
	})
}

func handleGeocode(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := 8
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 20 {
		limit = n
	}
	places, err := geo.search(r.Context(), q, limit)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"query": q, "results": places})
}

func handleReverse(w http.ResponseWriter, r *http.Request) {
	lat, okLat := parseFloat(r.URL.Query().Get("lat"))
	lng, okLng := parseFloat(r.URL.Query().Get("lng"))
	if !okLat || !okLng {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lat and lng required"})
		return
	}
	area, err := geo.reverse(r.Context(), lat, lng)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"lat": lat, "lng": lng, "area": area})
}

// handleOSM forwards a request to Nominatim's /search or /reverse verbatim
// (same query string, same raw JSON back) through the cache + rate limiter.
func handleOSM(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := nominatimBase + "/" + kind
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		body, err := geo.fetch(r.Context(), u)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Pawa-Gateway", "osm-passthrough")
		_, _ = w.Write(body)
	}
}

// ---- /match : the "Match to my life" ranking ------------------------------

type place struct {
	Label  string  `json:"label"`
	Lat    float64 `json:"lat"`
	Lng    float64 `json:"lng"`
	Mode   string  `json:"mode"`
	MaxMin float64 `json:"maxMin"` // 0 = no limit
}

type listing struct {
	ID  string  `json:"id"`
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type leg struct {
	Label string  `json:"label"`
	Km    float64 `json:"km"`
	Min   float64 `json:"min"`
	OK    bool    `json:"ok"`
}

type matchResult struct {
	ID       string  `json:"id"`
	TotalMin float64 `json:"total_min"`
	Pass     bool    `json:"pass"`
	Legs     []leg   `json:"legs"`
}

type matchRequest struct {
	Places   []place   `json:"places"`
	Listings []listing `json:"listings"`
	// PassOnly drops listings that bust any place's max-time limit.
	PassOnly bool `json:"passOnly"`
}

// handleMatch ranks listings by total estimated commute time across every
// place the user cares about — the home that fits your life best sits first.
// Pure maths (geo.go), so no upstream call and it scales to large lists.
func handleMatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var req matchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json: " + err.Error()})
		return
	}
	if len(req.Places) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "places required"})
		return
	}

	results := make([]matchResult, 0, len(req.Listings))
	for _, l := range req.Listings {
		legs := make([]leg, 0, len(req.Places))
		var total float64
		pass := true
		for _, p := range req.Places {
			km := roadKm(p.Lat, p.Lng, l.Lat, l.Lng)
			min := travelMin(km, p.Mode)
			ok := p.MaxMin == 0 || min <= p.MaxMin
			if !ok {
				pass = false
			}
			total += min
			legs = append(legs, leg{Label: p.Label, Km: round1(km), Min: round1(min), OK: ok})
		}
		if req.PassOnly && !pass {
			continue
		}
		results = append(results, matchResult{ID: l.ID, TotalMin: round1(total), Pass: pass, Legs: legs})
	}

	// Rank: passing listings first, then by least total commute time.
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Pass != results[j].Pass {
			return results[i].Pass
		}
		return results[i].TotalMin < results[j].TotalMin
	})

	writeJSON(w, http.StatusOK, map[string]any{"count": len(results), "results": results})
}

// ---- small helpers --------------------------------------------------------

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func parseFloat(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f, err == nil
}

func parseLatLng(latS, lonS string) (float64, float64, bool) {
	lat, okLat := parseFloat(latS)
	lng, okLng := parseFloat(lonS)
	return lat, lng, okLat && okLng
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

func firstTwoParts(display string) string {
	parts := strings.Split(display, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return strings.Join(parts, ", ")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func title(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
