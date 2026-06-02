//! Pawa Houses — the matching engine (Rust → WASM).
//!
//! Role in the polyglot stack (see ../../docs/LANGUAGE-ROUTING.md): CPU-bound,
//! perf-critical geo + scoring over the whole listings set, compiled to
//! `wasm32-unknown-unknown` so the **buildless** static frontend runs it with
//! no build step — the page just `fetch`es the prebuilt `js/house-match.wasm`.
//!
//! It answers the renter side of the feature: "given where I want to live, my
//! budget and my specs, rank every listing by how well it fits." One pass
//! produces a composite 0..100 score + the great-circle distance for each.
//!
//! ## ABI (dependency-free: no serde, no wasm-bindgen)
//!
//! The JS loader packs everything into one `Float64Array` and reads one back.
//!
//! Input buffer layout (all f64):
//! ```text
//!   [0] anchor_lat            [1] anchor_lng        [2] has_anchor (1|0)
//!   [3] max_budget_tzs (0=no cap)                   [4] min_bedrooms (0=any)
//!   [5] listing_filter (-1 any | 0 rent | 1 sale)
//!   [6] type_filter    (-1 any | 0 apt | 1 house | 2 plot | 3 office)
//!   [7] n  = number of listings
//!   then n records × 6: lat, lng, price_tzs, bedrooms, listing_code, type_code
//! ```
//! Output buffer: n records × 2 → [score, dist_km].
//!   score < 0  → hard-filtered out (caller should drop it).

const EARTH_KM: f64 = 6371.0;
const HEADER: usize = 8;
const IN_STRIDE: usize = 6;
const OUT_STRIDE: usize = 2;

fn to_rad(d: f64) -> f64 {
    d * core::f64::consts::PI / 180.0
}

/// Haversine great-circle distance in km — identical maths to js/houses.js
/// (`distKm`) and services/go/geo.go so all three agree to the metre.
fn dist_km(a_lat: f64, a_lng: f64, b_lat: f64, b_lng: f64) -> f64 {
    let d_lat = to_rad(b_lat - a_lat);
    let d_lng = to_rad(b_lng - a_lng);
    let x = (d_lat / 2.0).sin().powi(2)
        + to_rad(a_lat).cos() * to_rad(b_lat).cos() * (d_lng / 2.0).sin().powi(2);
    2.0 * EARTH_KM * x.sqrt().asin()
}

/// Composite fit score in 0..=100, weighting proximity, price fit and specs.
/// Returns `-1.0` when a hard filter rejects the listing.
fn score(
    anchor_lat: f64,
    anchor_lng: f64,
    has_anchor: bool,
    max_budget: f64,
    min_beds: f64,
    listing_filter: f64,
    type_filter: f64,
    lat: f64,
    lng: f64,
    price: f64,
    beds: f64,
    listing_code: f64,
    type_code: f64,
) -> (f64, f64) {
    // ---- hard filters --------------------------------------------------
    if listing_filter >= 0.0 && (listing_filter - listing_code).abs() > 0.5 {
        return (-1.0, 0.0);
    }
    if type_filter >= 0.0 && (type_filter - type_code).abs() > 0.5 {
        return (-1.0, 0.0);
    }
    // A budget is a ceiling: anything more than 10% over is out of reach.
    if max_budget > 0.0 && price > max_budget * 1.10 {
        return (-1.0, 0.0);
    }

    let dist = if has_anchor && lat.is_finite() && lng.is_finite() {
        dist_km(anchor_lat, anchor_lng, lat, lng)
    } else {
        f64::NAN
    };

    // ---- weighted components ------------------------------------------
    // Proximity (50): exponential decay — a home 5 km away scores ~37% of the
    // proximity weight, 10 km ~14%. No anchor → neutral full weight.
    let prox = if dist.is_finite() {
        50.0 * (-dist / 5.0).exp()
    } else {
        50.0
    };

    // Price fit (30): comfortably under budget is best; right at the ceiling
    // is fine; slightly over (the 10% grace band) is weak. No budget → full.
    let price_fit = if max_budget > 0.0 && price > 0.0 {
        let r = price / max_budget;
        if r <= 0.85 {
            30.0
        } else if r <= 1.0 {
            24.0
        } else {
            10.0
        }
    } else {
        30.0
    };

    // Spec fit (20): meets/exceeds the bedroom ask is best; one short is half;
    // further short tapers. No bedroom ask → full.
    let spec_fit = if min_beds > 0.0 {
        if beds >= min_beds {
            20.0
        } else if beds >= min_beds - 1.0 {
            10.0
        } else {
            2.0
        }
    } else {
        20.0
    };

    let total = (prox + price_fit + spec_fit).clamp(0.0, 100.0);
    (total.round(), if dist.is_finite() { dist } else { -1.0 })
}

// ---------------------------------------------------------------------------
//  WASM linear-memory ABI
// ---------------------------------------------------------------------------

/// Allocate `len` f64 slots and hand the pointer to JS. JS must call `dealloc`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut f64 {
    let mut v: Vec<f64> = Vec::with_capacity(len);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Reclaim a buffer previously handed out by `alloc` / `match_listings`.
///
/// # Safety
/// `ptr`/`len` must come from a prior `alloc(len)` (or a `match_listings`
/// result whose length is `2 * n`).
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut f64, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Score & measure every listing in the input buffer. Returns a pointer to a
/// freshly allocated output buffer of `2 * n` f64 ([score, dist_km] per
/// listing); JS knows `n` from the header and must `dealloc(out, 2*n)`.
///
/// # Safety
/// `ptr` must point at `len` readable f64 laid out per the module ABI.
#[no_mangle]
pub unsafe extern "C" fn match_listings(ptr: *mut f64, len: usize) -> *mut f64 {
    let input = core::slice::from_raw_parts(ptr, len);
    if input.len() < HEADER {
        return alloc(0);
    }

    let anchor_lat = input[0];
    let anchor_lng = input[1];
    let has_anchor = input[2] >= 0.5;
    let max_budget = input[3];
    let min_beds = input[4];
    let listing_filter = input[5];
    let type_filter = input[6];
    let n = input[7] as usize;

    let out_ptr = alloc(n * OUT_STRIDE);
    let out = core::slice::from_raw_parts_mut(out_ptr, n * OUT_STRIDE);

    for i in 0..n {
        let base = HEADER + i * IN_STRIDE;
        if base + IN_STRIDE > input.len() {
            break;
        }
        let (s, d) = score(
            anchor_lat,
            anchor_lng,
            has_anchor,
            max_budget,
            min_beds,
            listing_filter,
            type_filter,
            input[base],     // lat
            input[base + 1], // lng
            input[base + 2], // price
            input[base + 3], // beds
            input[base + 4], // listing_code
            input[base + 5], // type_code
        );
        out[i * OUT_STRIDE] = s;
        out[i * OUT_STRIDE + 1] = d;
    }

    out_ptr
}

// ---------------------------------------------------------------------------
//  Ride driver matching — rank the live online drivers nearest a pickup.
//
//  Powers ride.html: the rider FILTERS nearby drivers (this ranker) and the
//  dispatch chain offers the ride to them in order, instead of broadcasting to
//  everyone. Composite score = ETA proximity (dominant) + rating + freshness.
//
//  Input buffer (f64):
//    [0] pickup_lat  [1] pickup_lng  [2] vehicle_filter(-1 any, else code)  [3] n
//    then n records × 5: lat, lng, rating(0..5), age_sec(since last_seen), vehicle_code
//  Output: n × 2 → [score, eta_min].  score < 0 ⇒ excluded (stale or wrong vehicle).
// ---------------------------------------------------------------------------
const DRV_HEADER: usize = 4;
const DRV_IN_STRIDE: usize = 5;
const DRV_STALE_SEC: f64 = 90.0; // a driver unseen this long is treated as offline
const DRV_CITY_KMH: f64 = 28.0;  // assumed city driving speed for ETA

fn rank_driver(
    p_lat: f64, p_lng: f64, veh_filter: f64,
    lat: f64, lng: f64, rating: f64, age_sec: f64, veh_code: f64,
) -> (f64, f64) {
    if veh_filter >= 0.0 && (veh_filter - veh_code).abs() > 0.5 {
        return (-1.0, 0.0); // wrong vehicle type
    }
    if age_sec > DRV_STALE_SEC || !lat.is_finite() || !lng.is_finite() {
        return (-1.0, 0.0); // stale fix → effectively offline
    }
    let dist = dist_km(p_lat, p_lng, lat, lng);
    let eta = dist / DRV_CITY_KMH * 60.0; // minutes

    // Proximity dominates (70): a ~4-min ETA scores ~37% of it, decaying fast.
    let prox = 70.0 * (-eta / 4.0).exp();
    let rate = 20.0 * (rating.clamp(0.0, 5.0) / 5.0);
    let fresh = 10.0 * (1.0 - age_sec / DRV_STALE_SEC).clamp(0.0, 1.0);

    ((prox + rate + fresh).clamp(0.0, 100.0).round(), eta)
}

/// Score & ETA every candidate driver. Returns `2 * n` f64 ([score, eta_min]);
/// JS sorts by score desc and dispatches in that order.
///
/// # Safety
/// `ptr` must point at `len` readable f64 laid out per the ride ABI above.
#[no_mangle]
pub unsafe extern "C" fn rank_drivers(ptr: *mut f64, len: usize) -> *mut f64 {
    let input = core::slice::from_raw_parts(ptr, len);
    if input.len() < DRV_HEADER {
        return alloc(0);
    }
    let p_lat = input[0];
    let p_lng = input[1];
    let veh_filter = input[2];
    let n = input[3] as usize;

    let out_ptr = alloc(n * OUT_STRIDE);
    let out = core::slice::from_raw_parts_mut(out_ptr, n * OUT_STRIDE);

    for i in 0..n {
        let base = DRV_HEADER + i * DRV_IN_STRIDE;
        if base + DRV_IN_STRIDE > input.len() {
            break;
        }
        let (s, eta) = rank_driver(
            p_lat, p_lng, veh_filter,
            input[base], input[base + 1], input[base + 2], input[base + 3], input[base + 4],
        );
        out[i * OUT_STRIDE] = s;
        out[i * OUT_STRIDE + 1] = eta;
    }
    out_ptr
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closer_fresher_driver_ranks_higher() {
        // both same vehicle; A is 1 km & fresh, B is 8 km & older
        let (sa, ea) = rank_driver(-6.79, 39.27, -1.0, -6.80, 39.27, 5.0, 5.0, 0.0);
        let (sb, eb) = rank_driver(-6.79, 39.27, -1.0, -6.86, 39.20, 4.0, 60.0, 0.0);
        assert!(ea < eb);
        assert!(sa > sb, "near+fresh ({sa}) should beat far+stale ({sb})");
    }

    #[test]
    fn stale_or_wrong_vehicle_excluded() {
        let (s_stale, _) = rank_driver(-6.79, 39.27, -1.0, -6.79, 39.27, 5.0, 120.0, 0.0);
        assert_eq!(s_stale, -1.0);
        let (s_veh, _) = rank_driver(-6.79, 39.27, 1.0, -6.79, 39.27, 5.0, 5.0, 0.0);
        assert_eq!(s_veh, -1.0);
    }
}

#[cfg(test)]
mod house_tests {
    use super::*;

    #[test]
    fn nearer_and_in_budget_scores_higher() {
        // anchor in Dar; listing A is 1 km away and cheap, B is 12 km and dear.
        let (sa, da) = score(
            -6.79, 39.27, true, 1_000_000.0, 2.0, 0.0, -1.0, -6.80, 39.27, 600_000.0, 3.0, 0.0,
            0.0,
        );
        let (sb, db) = score(
            -6.79, 39.27, true, 1_000_000.0, 2.0, 0.0, -1.0, -6.90, 39.20, 980_000.0, 1.0, 0.0,
            0.0,
        );
        assert!(da < db);
        assert!(sa > sb, "near+cheap+specs ({sa}) should beat far+dear ({sb})");
    }

    #[test]
    fn over_budget_is_rejected() {
        let (s, _) = score(
            -6.79, 39.27, true, 500_000.0, 0.0, 0.0, -1.0, -6.79, 39.27, 900_000.0, 2.0, 0.0, 0.0,
        );
        assert_eq!(s, -1.0);
    }

    #[test]
    fn listing_kind_mismatch_is_rejected() {
        // want rent (0) but listing is sale (1)
        let (s, _) = score(
            0.0, 0.0, false, 0.0, 0.0, 0.0, -1.0, -6.79, 39.27, 0.0, 0.0, 1.0, 0.0,
        );
        assert_eq!(s, -1.0);
    }
}
