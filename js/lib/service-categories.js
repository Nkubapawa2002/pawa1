// ============================================================================
//  js/lib/service-categories.js
//  The service categories this marketplace covers, in one place.
//
//  The homepage trust strip claims a number of service categories. That number
//  has to come from somewhere real, or it is decoration: this list IS the
//  claim. Add a category here and the strip counts it on the next load.
//
//  The same keys are the `category` values written to public.services and the
//  option values in services.html / agent-services.html. Labels are NOT here —
//  they live in js/core/i18n.js like every other visible string.
// ============================================================================

(function () {
  window.SERVICE_CATEGORIES = Object.freeze([
    "cleaning",
    "plumbing",
    "electrical",
    "carpentry",
    "painting",
    "gardening",
    "moving_help",
    "laundry",
    "cooking",
    "tutoring",
    "beauty",
    "security",
    "childcare",
    "appliance_repair",
    "other",
  ]);
})();
