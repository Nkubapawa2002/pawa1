package main

// Pure geo maths — no I/O, no dependencies. Ported 1:1 from js/houses.js so
// the Go service and the browser agree to the metre. Keep them in sync.

import "math"

// Tanzania mainland bounding box. A geocode hit outside this never anchors the
// map (mirrors the check in geocodePlace()).
const (
	tzLatMin = -11.75
	tzLatMax = -0.99
	tzLngMin = 29.34
	tzLngMax = 40.45

	earthKm    = 6371.0 // mean Earth radius
	roadDetour = 1.3    // straight-line km × this ≈ road km in a TZ city
)

// Mode is a way of getting around, with its assumed average city speed.
type Mode struct {
	Label string  `json:"label"`
	Icon  string  `json:"icon"`
	Kmh   float64 `json:"kmh"`
}

// Modes mirrors MODES in js/houses.js. car is the fallback.
var Modes = map[string]Mode{
	"walk":     {"Walk", "🚶", 4.5},
	"bodaboda": {"Bodaboda", "🏍️", 22},
	"bajaji":   {"Bajaji", "🛺", 18},
	"daladala": {"Daladala", "🚌", 16},
	"car":      {"Car", "🚗", 26},
}

func modeOf(m string) Mode {
	if mode, ok := Modes[m]; ok {
		return mode
	}
	return Modes["car"]
}

func inTanzania(lat, lng float64) bool {
	return lat >= tzLatMin && lat <= tzLatMax && lng >= tzLngMin && lng <= tzLngMax
}

func toRad(d float64) float64 { return d * math.Pi / 180 }

// distKm is the haversine great-circle distance in kilometres.
func distKm(aLat, aLng, bLat, bLng float64) float64 {
	dLat := toRad(bLat - aLat)
	dLng := toRad(bLng - aLng)
	x := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRad(aLat))*math.Cos(toRad(bLat))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthKm * math.Asin(math.Sqrt(x))
}

func roadKm(aLat, aLng, bLat, bLng float64) float64 {
	return distKm(aLat, aLng, bLat, bLng) * roadDetour
}

func travelMin(km float64, mode string) float64 {
	return km / modeOf(mode).Kmh * 60
}
