// Shared dataset of Tanzanian places used by ride.js and meet.js
// Keep coordinates as approximate centroids — good enough for map markers.

window.TZ_UNIVERSITIES = [
  // Dar es Salaam
  { name: "University of Dar es Salaam (UDSM)",                   kind: "university", city: "Dar es Salaam", lat: -6.7798, lng: 39.2069 },
  { name: "Muhimbili University of Health & Allied Sciences",     kind: "university", city: "Dar es Salaam", lat: -6.8094, lng: 39.2784 },
  { name: "Ardhi University",                                     kind: "university", city: "Dar es Salaam", lat: -6.7733, lng: 39.2103 },
  { name: "Open University of Tanzania",                          kind: "university", city: "Dar es Salaam", lat: -6.8369, lng: 39.2697 },
  { name: "Hubert Kairuki Memorial University",                   kind: "university", city: "Dar es Salaam", lat: -6.7600, lng: 39.2350 },
  { name: "International Medical & Technological University",     kind: "university", city: "Dar es Salaam", lat: -6.7980, lng: 39.2540 },
  { name: "Kampala International University - Dar es Salaam",     kind: "university", city: "Dar es Salaam", lat: -6.8161, lng: 39.2803 },
  { name: "Dar es Salaam Tumaini University",                     kind: "university", city: "Dar es Salaam", lat: -6.8210, lng: 39.2770 },
  { name: "Dar es Salaam Institute of Technology (DIT)",          kind: "institute",  city: "Dar es Salaam", lat: -6.8167, lng: 39.2833 },
  { name: "Institute of Finance Management (IFM)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8169, lng: 39.2871 },
  { name: "College of Business Education (CBE)",                  kind: "college",    city: "Dar es Salaam", lat: -6.8156, lng: 39.2809 },
  { name: "National Institute of Transport (NIT)",                kind: "institute",  city: "Dar es Salaam", lat: -6.8240, lng: 39.2440 },
  { name: "Tanzania Institute of Accountancy (TIA)",              kind: "institute",  city: "Dar es Salaam", lat: -6.8196, lng: 39.2800 },

  // Morogoro
  { name: "Sokoine University of Agriculture (SUA)",              kind: "university", city: "Morogoro",      lat: -6.8489, lng: 37.6533 },
  { name: "Mzumbe University",                                    kind: "university", city: "Morogoro",      lat: -6.9158, lng: 37.4944 },
  { name: "Jordan University College",                            kind: "college",    city: "Morogoro",      lat: -6.8167, lng: 37.6833 },

  // Dodoma
  { name: "University of Dodoma (UDOM)",                          kind: "university", city: "Dodoma",        lat: -6.1810, lng: 35.7780 },
  { name: "St. John's University of Tanzania",                    kind: "university", city: "Dodoma",        lat: -6.1660, lng: 35.7480 },
  { name: "College of Business Education - Dodoma",               kind: "college",    city: "Dodoma",        lat: -6.1700, lng: 35.7390 },

  // Arusha / Kilimanjaro region
  { name: "Nelson Mandela African Institute of Science & Tech.",  kind: "institute",  city: "Arusha",        lat: -3.4032, lng: 36.7867 },
  { name: "Mount Meru University",                                kind: "university", city: "Arusha",        lat: -3.3700, lng: 36.6900 },
  { name: "Tumaini University Makumira",                          kind: "university", city: "Usa River",     lat: -3.3300, lng: 36.8900 },
  { name: "Institute of Accountancy Arusha (IAA)",                kind: "institute",  city: "Arusha",        lat: -3.3600, lng: 36.6800 },
  { name: "Mwenge Catholic University",                           kind: "university", city: "Moshi",         lat: -3.3500, lng: 37.3300 },
  { name: "Stefano Moshi Memorial University College",            kind: "college",    city: "Moshi",         lat: -3.3300, lng: 37.3500 },
  { name: "Kilimanjaro Christian Medical University College",     kind: "college",    city: "Moshi",         lat: -3.3520, lng: 37.3440 },

  // Mwanza
  { name: "St. Augustine University of Tanzania (SAUT)",          kind: "university", city: "Mwanza",        lat: -2.5717, lng: 32.8967 },
  { name: "Catholic University of Health & Allied Sciences",      kind: "university", city: "Mwanza",        lat: -2.5169, lng: 32.9192 },
  { name: "Bugando University - College",                         kind: "college",    city: "Mwanza",        lat: -2.5160, lng: 32.9180 },

  // Iringa
  { name: "University of Iringa",                                 kind: "university", city: "Iringa",        lat: -7.7700, lng: 35.7000 },
  { name: "Mkwawa University College of Education (MUCE)",        kind: "college",    city: "Iringa",        lat: -7.7670, lng: 35.6790 },
  { name: "Ruaha Catholic University (RUCU)",                     kind: "university", city: "Iringa",        lat: -7.7730, lng: 35.6900 },

  // Mbeya
  { name: "Mbeya University of Science & Technology",             kind: "university", city: "Mbeya",         lat: -8.9180, lng: 33.4520 },
  { name: "Teofilo Kisanji University",                           kind: "university", city: "Mbeya",         lat: -8.9050, lng: 33.4500 },

  // Tanga / Zanzibar / Mtwara / Bukoba / Tabora
  { name: "Eckernforde Tanga University",                         kind: "university", city: "Tanga",         lat: -5.0700, lng: 39.0950 },
  { name: "State University of Zanzibar (SUZA)",                  kind: "university", city: "Zanzibar",      lat: -6.1663, lng: 39.2026 },
  { name: "Zanzibar University",                                  kind: "university", city: "Zanzibar",      lat: -6.1340, lng: 39.2070 },
  { name: "Stella Maris Mtwara University College",               kind: "college",    city: "Mtwara",        lat: -10.2667,lng: 40.1833 },
  { name: "Kampala International University - Bukoba",            kind: "college",    city: "Bukoba",        lat: -1.3300, lng: 31.8120 },
  { name: "Tabora Teachers College",                              kind: "college",    city: "Tabora",        lat: -5.0200, lng: 32.8030 },
];
