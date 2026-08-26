#!/usr/bin/env node
/* ============================================================
   Design-token adherence check — Maisha na Lifeza

   Single source of truth is css/ds/tokens/*.css, which is a
   verbatim mirror of the `tokens/` folder in the Claude Design
   project "Maisha na Lifeza Design System". Nothing is duplicated
   here: the token table below is parsed out of that CSS at runtime,
   so this check can never drift from the design system.

   What it reports: a raw colour literal whose value is EXACTLY a
   brand token. That is the high-signal case — the author meant the
   brand colour and typed the hex instead of reaching for the token.

     node scripts/design/check_tokens.mjs            # report
     node scripts/design/check_tokens.mjs --strict   # exit 1 on any hit
     node scripts/design/check_tokens.mjs --fonts    # also audit font-family
     node scripts/design/check_tokens.mjs --json     # machine-readable
   ============================================================ */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN_DIR = join(ROOT, 'css', 'ds', 'tokens');

/* Directories that are builds, vendored copies or the tokens themselves. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'www', 'dist', 'build', 'ios']);
/* Not product UI — fixtures, one-shot migrations and seed data. Scanned with --all. */
const NON_UI_DIRS = new Set(['tests', 'data', 'supabase', join('scripts', 'archive')]);

/* Neutrals a literal can legitimately spell: #fff inside an SVG or a shadow is
   not a brand miss. Reported only under --all so the brand tier stays actionable. */
const NEUTRAL_TOKENS = new Set([
  '--white', '--black', '--gray', '--gray-light', '--gray-mid',
  '--border', '--border-strong', '--border-light', '--text-ink',
]);
const SCAN_EXT = new Set(['.html', '.css', '.js', '.mjs', '.jsx']);

const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has('--strict');
const ALL = ARGS.has('--all');
const CHECK_FONTS = ARGS.has('--fonts');
const AS_JSON = ARGS.has('--json');

/* ---------- 1. Parse the design system's own token files ---------- */

/** Expand #abc to #aabbcc and lowercase, so literals compare cleanly. */
function normalizeHex(hex) {
  let h = hex.slice(1).toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  return '#' + h;
}

/** Collapse whitespace inside rgb()/rgba() so "rgba(16, 185, 129, .1)" matches. */
function normalizeFunc(value) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(\D)0\./g, '$1.'); // 0.10 -> .10, so both spellings land together
}

function normalizeValue(raw) {
  const v = raw.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return normalizeHex(v);
  if (/^rgba?\(/i.test(v)) return normalizeFunc(v);
  return null;
}

function loadTokens() {
  const byValue = new Map(); // normalized value -> [token names]
  const names = new Set();
  for (const file of readdirSync(TOKEN_DIR).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(TOKEN_DIR, file), 'utf8');
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      const name = m[1];
      names.add(name);
      const key = normalizeValue(m[2]);
      if (!key) continue;
      if (!byValue.has(key)) byValue.set(key, []);
      if (!byValue.get(key).includes(name)) byValue.get(key).push(name);
    }
  }
  return { byValue, names };
}

/** The five families the design system ships. Read from fonts.css, not hardcoded. */
function loadFontFamilies() {
  const css = readFileSync(join(TOKEN_DIR, 'fonts.css'), 'utf8');
  const families = new Set();
  for (const m of css.matchAll(/family=([A-Za-z+]+)[:&]/g)) {
    families.add(m[1].replace(/\+/g, ' ').toLowerCase());
  }
  return families;
}

/* ---------- 2. Walk the source tree ---------- */

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SCAN_EXT.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

function isTokenSource(relPath) {
  return relPath.split(sep).join('/').startsWith('css/ds/tokens/');
}

function isNonUi(relPath) {
  const parts = relPath.split(sep);
  return NON_UI_DIRS.has(parts[0]) || NON_UI_DIRS.has(join(parts[0], parts[1] || ''));
}

/* ---------- 3. Find literals that should have been tokens ---------- */

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
/* Generic stacks every browser understands are not "unbranded fonts". */
const SYSTEM_FACES = new Set([
  'system-ui', 'sans-serif', 'serif', 'monospace', 'ui-monospace', 'cursive',
  '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica',
  'helvetica neue', 'arial', 'georgia', 'times new roman', 'menlo', 'sf mono',
  'consolas', 'courier new', 'inherit', 'initial', 'unset',
  'sfmono-regular', 'ui-sans-serif', 'ui-serif', 'noto sans', 'liberation sans',
]);

function auditFile(full, tokens, fonts) {
  const relPath = relative(ROOT, full);
  if (isTokenSource(relPath)) return [];
  if (full === fileURLToPath(import.meta.url)) return []; // this file talks about tokens
  if (!ALL && isNonUi(relPath)) return [];

  const findings = [];
  const lines = readFileSync(full, 'utf8').split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const raw of line.match(COLOR_LITERAL) || []) {
      const key = normalizeValue(raw);
      const hit = key && tokens.byValue.get(key);
      if (!hit) continue;
      /* Prefer a brand token over a neutral one when a value carries both. */
      const brand = hit.find((t) => !NEUTRAL_TOKENS.has(t));
      if (!brand && !ALL) continue;
      const token = brand || hit[0];
      findings.push({
        file: relPath, line: i + 1, kind: 'color', tier: brand ? 'brand' : 'neutral',
        found: raw, suggest: `var(${token})`,
        detail: hit.length > 1 ? `also: ${hit.filter((t) => t !== token).join(', ')}` : '',
        text: line.trim().slice(0, 100),
      });
    }

    if (!CHECK_FONTS) return;
    /* Both a real declaration and a custom property that holds a font stack —
       a second design system hides in `--x-font-display: "Source Serif 4"`. */
    const fm = line.match(/(?:font-family|--[a-z0-9-]*font[a-z0-9-]*)\s*:\s*([^;}]+)/i);
    if (!fm) return;
    /* A var() reference is already the design system speaking — its fallback
       list is part of the token, not a font choice made here. */
    const decl = fm[1].trim();
    if (decl.startsWith('var(')) return;
    for (const face of decl.split(',')) {
      const name = face.trim().replace(/[)!;]+$/, '').replace(/^["']|["']$/g, '').trim().toLowerCase();
      if (!name || SYSTEM_FACES.has(name)) continue;
      if (fonts.has(name)) continue;
      findings.push({
        file: relPath, line: i + 1, kind: 'font', tier: 'brand',
        found: name, suggest: 'a --font-* token',
        detail: `not shipped by the design system (${[...fonts].join(', ')})`,
        text: line.trim().slice(0, 100),
      });
    }
  });

  return findings;
}

/* ---------- 4. Report ---------- */

const tokens = loadTokens();
const fonts = loadFontFamilies();

const findings = [];
for (const file of walk(ROOT)) findings.push(...auditFile(file, tokens, fonts));

if (AS_JSON) {
  console.log(JSON.stringify({ tokenCount: tokens.names.size, findings }, null, 2));
} else {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  console.log(`\nDesign-token adherence — ${tokens.names.size} tokens loaded from css/ds/tokens/\n`);
  if (!findings.length) {
    console.log('  No raw literals matching a brand token. Clean.\n');
  } else {
    const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [file, hits] of ranked) {
      console.log(`  ${file}  (${hits.length})`);
      for (const h of hits) {
        const extra = h.detail ? `  — ${h.detail}` : '';
        console.log(`    ${String(h.line).padStart(5)}  ${h.found}  ->  ${h.suggest}${extra}`);
      }
      console.log('');
    }
    console.log(`  ${findings.length} literal(s) across ${byFile.size} file(s) duplicate a brand token.`);
    console.log(`  Replace each with its var() so a design-system change reaches them.\n`);
  }
}

if (STRICT && findings.length) process.exit(1);
