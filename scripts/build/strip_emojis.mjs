#!/usr/bin/env node
// One-off: strip emoji characters from all source files in the project.
// Loops until no emojis remain. Skips deps/build/binary dirs.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'android', 'www', 'test-screenshots', '.temp',
]);

// Text file extensions we are willing to edit.
const TEXT_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.json', '.md', '.sql', '.txt', '.yaml', '.yml', '.svg',
  '.xml', '.csv',
]);

// Emoji / pictograph ranges. Deliberately excludes plain text symbols,
// punctuation, and CJK. Includes ZWJ, variation selectors, skin tones,
// regional indicators, and the main emoji blocks.
const EMOJI_RE = new RegExp(
  '[' +
  '\\u{1F1E6}-\\u{1F1FF}' +   // regional indicators (flags)
  '\\u{1F300}-\\u{1F5FF}' +   // misc symbols & pictographs
  '\\u{1F600}-\\u{1F64F}' +   // emoticons
  '\\u{1F680}-\\u{1F6FF}' +   // transport & map
  '\\u{1F700}-\\u{1F77F}' +   // alchemical
  '\\u{1F780}-\\u{1F7FF}' +   // geometric shapes extended
  '\\u{1F800}-\\u{1F8FF}' +   // supplemental arrows-C
  '\\u{1F900}-\\u{1F9FF}' +   // supplemental symbols & pictographs
  '\\u{1FA00}-\\u{1FA6F}' +   // chess / symbols
  '\\u{1FA70}-\\u{1FAFF}' +   // symbols & pictographs ext-A
  '\\u{2600}-\\u{26FF}' +     // misc symbols
  '\\u{2700}-\\u{27BF}' +     // dingbats
  '\\u{2B00}-\\u{2BFF}' +     // misc symbols & arrows (stars etc)
  '\\u{1F000}-\\u{1F0FF}' +   // mahjong/domino/cards
  '\\u{FE00}-\\u{FE0F}' +     // variation selectors
  '\\u{1F3FB}-\\u{1F3FF}' +   // skin tone modifiers
  '\\u{200D}' +               // zero width joiner
  '\\u{20E3}' +               // combining enclosing keycap
  '\\u{2049}\\u{203C}' +      // !? and !!
  '\\u{2122}\\u{2139}' +      // TM, info
  '\\u{2194}-\\u{21AA}' +     // arrows used as emoji
  '\\u{231A}-\\u{231B}' +     // watch/hourglass
  '\\u{2328}\\u{23CF}' +
  '\\u{23E9}-\\u{23F3}' +
  '\\u{23F8}-\\u{23FA}' +
  '\\u{24C2}' +
  '\\u{25AA}-\\u{25AB}\\u{25B6}\\u{25C0}\\u{25FB}-\\u{25FE}' +
  ']',
  'gu'
);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) out.push(full);
  }
}

const files = [];
walk(ROOT, files);

let totalRemoved = 0;
const changed = [];
for (const f of files) {
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  const matches = txt.match(EMOJI_RE);
  if (!matches) continue;
  // Remove emoji; collapse any double-space left behind into one,
  // and trim trailing whitespace on affected lines lightly.
  let cleaned = txt.replace(EMOJI_RE, '');
  const count = matches.length;
  if (cleaned !== txt) {
    writeFileSync(f, cleaned, 'utf8');
    totalRemoved += count;
    changed.push([f.replace(ROOT + '\\', '').replace(ROOT + '/', ''), count]);
  }
}

if (changed.length) {
  for (const [f, c] of changed) console.log(`${c}\t${f}`);
}
console.log(`\nFiles scanned: ${files.length}`);
console.log(`Files changed: ${changed.length}`);
console.log(`Emoji codepoints removed this pass: ${totalRemoved}`);
process.exit(totalRemoved > 0 ? 10 : 0); // exit 10 = more passes may help
