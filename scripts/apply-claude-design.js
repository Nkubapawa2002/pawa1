// Insert <link href="css/claude-design.css"> into every HTML page in
// `bus web/` if it isn't already there. Inserted right BEFORE </head>
// so it cascades on top of the legacy stylesheets.

const fs   = require("node:fs");
const path = require("node:path");

const DIR  = path.join(__dirname, "..");
const NEEDLE = `<link rel="stylesheet" href="css/claude-design.css" />`;

let touched = 0, skipped = 0;
for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith(".html")) continue;
  const abs = path.join(DIR, name);
  const src = fs.readFileSync(abs, "utf8");
  if (src.includes("css/claude-design.css")) { skipped++; continue; }
  if (!src.includes("</head>")) { skipped++; continue; }
  // Place right before </head> so it wins the cascade.
  const next = src.replace("</head>", "  " + NEEDLE + "\n</head>");
  fs.writeFileSync(abs, next);
  console.log("  +", name);
  touched++;
}
console.log(`\nTouched ${touched} file(s). Skipped ${skipped}.`);
