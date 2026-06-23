// One-off: wire the theme switch into every root HTML page.
//  - <script src="js/theme.js"></script> as the FIRST child of <head>
//    (synchronous + early → applies data-theme before first paint, no flash).
//  - <link rel="stylesheet" href="css/theme-light.css"> as the LAST element
//    before </head> (loads after neon-pro + design-system → wins the cascade).
// Idempotent: skips a page that already has each tag.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const SCRIPT_TAG = '<script src="js/theme.js"></script>';
const LINK_TAG = '<link rel="stylesheet" href="css/theme-light.css" />';

const files = readdirSync(".").filter((f) => f.endsWith(".html"));
const report = [];

for (const file of files) {
  let html = readFileSync(file, "utf8");
  const before = html;

  if (!html.includes("js/theme.js")) {
    html = html.replace(/<head>/i, `<head>\n  ${SCRIPT_TAG}`);
  }
  if (!html.includes("css/theme-light.css")) {
    html = html.replace(/<\/head>/i, `  ${LINK_TAG}\n</head>`);
  }

  if (html !== before) {
    writeFileSync(file, html, "utf8");
    report.push(`updated ${file}`);
  } else {
    report.push(`skip    ${file}`);
  }
}
console.log(report.join("\n"));
console.log(`\n${files.length} html files processed`);
