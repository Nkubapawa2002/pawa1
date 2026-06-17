// =====================================================================
// scripts/wire_mobile_into_pages.js
// Adds the phone-first bundle to every HTML page in `bus web/`:
//   <head>: manifest link + theme-color + apple-touch-icon + viewport-fit
//           + css/mobile.css (after styles.css)
//   <body data-page="<filename>"> for the mobile-nav active matcher
//   <script>: mobile-nav.js, fab.js, sw-register.js (before </body>)
//
// Idempotent — running it twice doesn't duplicate.
// =====================================================================

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MARKER = "<!-- pawa-mobile-bundle -->";

const HEAD_INJECT = `
    <link rel="manifest" href="manifest.json" />
    <meta name="theme-color" content="#0a6f4d" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="icons/icon-maskable.svg" />
    <link rel="icon" href="icons/icon-maskable.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="css/mobile.css" />
${MARKER}`;

const BODY_INJECT = `
    <script src="js/mobile-nav.js"></script>
    <script src="js/fab.js"></script>
    <script src="js/sw-register.js"></script>
${MARKER}`;

function patchFile(file) {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARKER)) return { file, changed: false, reason: "already_patched" };

  const base = path.basename(file);
  const dataPage = base.replace(/\.html$/, "");

  // 1) viewport-fit on existing viewport meta (or add one)
  if (!/viewport-fit\s*=\s*cover/i.test(src)) {
    if (/<meta[^>]+name=["']viewport["'][^>]*>/i.test(src)) {
      src = src.replace(
        /<meta([^>]+)name=["']viewport["']([^>]*)>/i,
        (m, a, b) => {
          const all = (a + b);
          if (/viewport-fit/.test(all)) return m;
          return `<meta${a}name="viewport"${b.replace(/content=["']([^"']+)["']/i, (mm, c) => `content="${c}, viewport-fit=cover"`)}>`;
        }
      );
    }
  }

  // 2) head injection: place right before </head>
  if (/<\/head>/i.test(src)) {
    src = src.replace(/<\/head>/i, HEAD_INJECT + "\n  </head>");
  } else {
    src = HEAD_INJECT + "\n" + src;
  }

  // 3) data-page on <body>
  src = src.replace(/<body\b([^>]*)>/i, (m, attrs) => {
    if (/data-page\s*=/.test(attrs)) return m;
    return `<body${attrs} data-page="${dataPage}">`;
  });

  // 4) script bundle: before </body>
  if (/<\/body>/i.test(src)) {
    src = src.replace(/<\/body>/i, BODY_INJECT + "\n</body>");
  } else {
    src += "\n" + BODY_INJECT;
  }

  fs.writeFileSync(file, src);
  return { file, changed: true };
}

const pages = fs.readdirSync(ROOT).filter(n => n.endsWith(".html"));
let changed = 0, skipped = 0;
for (const f of pages) {
  const r = patchFile(path.join(ROOT, f));
  console.log(`  ${r.changed ? "" : "·"} ${f}${r.reason ? " ("+r.reason+")" : ""}`);
  if (r.changed) changed++; else skipped++;
}
console.log(`patched=${changed}, skipped=${skipped}, total=${pages.length}`);
