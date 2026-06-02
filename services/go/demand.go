package main

// Demand-pin notify gateway.
//
// Role in the polyglot stack (see ../../docs/LANGUAGE-ROUTING.md): the
// event-driven side of the Houses "demand pin" feature. A renter pins the area
// they want with a budget + specs + phone; when an agent posts a property
// there, the agent must be shown how many people are waiting nearby and their
// numbers.
//
// The in-app path (agent dashboard) calls the Supabase SECURITY DEFINER RPC
// directly from the browser, so it works on GitHub Pages with no server. THIS
// gateway is where richer fan-out lives when you want it: SMS via Africa's
// Talking, push, or a nightly "5 people are still waiting in Mikocheni" digest.
// It runs server-side with the Supabase SERVICE key, so it can read phones
// across users and (later) message them.
//
// Endpoints (JSON, CORS-open):
//
//	POST /demand/near  {lat,lng,radius_m,listing,type,price,bedrooms}
//	                   → {count, results:[{phone,area,distance_m,…}]}
//	POST /demand/pin   {lat,lng,phone,listing,…}  → created pin row
//
// Config (env): SUPABASE_URL + SUPABASE_SERVICE_KEY. Without them the
// endpoints return 503 so the rest of the gateway still runs.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func supabaseURL() string { return strings.TrimRight(os.Getenv("SUPABASE_URL"), "/") }
func serviceKey() string {
	return firstNonEmpty(os.Getenv("SUPABASE_SERVICE_KEY"), os.Getenv("SUPABASE_SERVICE_ROLE_KEY"))
}
func supabaseReady() bool { return supabaseURL() != "" && serviceKey() != "" }

// demandNearRequest mirrors the RPC args; only lat/lng are required.
type demandNearRequest struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	RadiusM  int     `json:"radius_m"`
	Listing  string  `json:"listing"`
	Type     string  `json:"type"`
	Price    int64   `json:"price"`
	Bedrooms int     `json:"bedrooms"`
}

func handleDemandNear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	if !supabaseReady() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "gateway not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY"})
		return
	}
	var req demandNearRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json: " + err.Error()})
		return
	}
	if !inTanzania(req.Lat, req.Lng) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lat/lng outside Tanzania"})
		return
	}
	if req.RadiusM <= 0 {
		req.RadiusM = 1500
	}
	if req.Listing == "" {
		req.Listing = "rent"
	}

	// Build the RPC argument object. null for the optional text/number filters
	// so the SQL "is null → don't filter" branches kick in.
	args := map[string]any{
		"p_lat":      req.Lat,
		"p_lng":      req.Lng,
		"p_radius_m": req.RadiusM,
		"p_listing":  req.Listing,
		"p_price":    req.Price,
		"p_bedrooms": req.Bedrooms,
	}
	if req.Type != "" {
		args["p_type"] = req.Type
	} else {
		args["p_type"] = nil
	}

	body, status, err := callRPC(r.Context(), "house_demand_near", args)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if status >= 300 {
		writeJSON(w, status, map[string]string{"error": "supabase rpc failed", "detail": string(body)})
		return
	}

	var rows []map[string]any
	_ = json.Unmarshal(body, &rows)
	writeJSON(w, http.StatusOK, map[string]any{"count": len(rows), "results": rows})
}

func handleDemandPin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	if !supabaseReady() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "gateway not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY"})
		return
	}
	var pin map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&pin); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json: " + err.Error()})
		return
	}
	if pin["phone"] == nil || pin["lat"] == nil || pin["lng"] == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lat, lng and phone are required"})
		return
	}
	if pin["id"] == nil {
		pin["id"] = fmt.Sprintf("dp-%d", time.Now().UnixNano())
	}

	body, status, err := callREST(r.Context(), http.MethodPost, "/rest/v1/house_demand_pins", pin,
		map[string]string{"Prefer": "return=representation"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if status >= 300 {
		writeJSON(w, status, map[string]string{"error": "supabase insert failed", "detail": string(body)})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// ---- Supabase helpers ------------------------------------------------------

var sbClient = &http.Client{Timeout: 10 * time.Second}

func callRPC(ctx context.Context, fn string, args map[string]any) ([]byte, int, error) {
	return callREST(ctx, http.MethodPost, "/rest/v1/rpc/"+fn, args, nil)
}

func callREST(ctx context.Context, method, path string, payload any, extra map[string]string) ([]byte, int, error) {
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, method, supabaseURL()+path, bytes.NewReader(buf))
	if err != nil {
		return nil, 0, err
	}
	key := serviceKey()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", key)
	req.Header.Set("Authorization", "Bearer "+key)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := sbClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return body, resp.StatusCode, nil
}
