// =====================================================================
// scripts/patch_workflows_for_tenancy.js
// Mutates n8n/01_vapi_tools.json and n8n/01b_extended_tools.json so
// every tool is tenant-aware:
//   1. Each "Parse * Args" code node extracts `tenant_slug` from the
//      VAPI variableValues (or top-level body) and forwards it.
//   2. Each Postgres query that touches a tenant-scoped table gets a
//      `AND tenant_slug = $N` added to its WHERE clause (or a column
//      added to its INSERT), and queryReplacement is updated with the
//      tenant_slug expression.
//
// The transform is idempotent: running it twice leaves the file the
// same.  Tables in TENANT_TABLES are tenant-scoped; nearest_hubs and
// regions are not.
// =====================================================================

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
  path.join(ROOT, "n8n", "01_vapi_tools.json"),
  path.join(ROOT, "n8n", "01b_extended_tools.json"),
];

// Tables / views we filter by tenant_slug. Reference tables omitted.
const TENANT_TABLES = new Set([
  // booking DB
  "bookings", "trips", "seats", "routes", "payments", "complaints",
  "service_gaps", "scheduled_reminders", "manager_actions",
  "agent_actions_log", "message_log", "parcel_quotes", "call_requests",
  // booking DB views
  "customer_history_v",
  // website DB (cargo)
  "shipments", "agents", "buses",
]);

// Marker we add to parsed args so we don't re-patch.
const PARSE_MARKER = "/* tenancy:patched */";
const QUERY_MARKER = "/* tenancy:patched */";

let totalParseEdits = 0, totalQueryEdits = 0, totalReplEdits = 0;

function patchParseCode(code) {
  if (code.includes(PARSE_MARKER)) return code;
  // Standard parse pattern starts with: const body=$input.first().json.body||$input.first().json;
  // We splice in a tenant_slug extraction block right after that line.
  const insertion = `\nconst tenantSlug = ${PARSE_MARKER} (body.message?.assistantOverrides?.variableValues?.tenant_slug) || (body.message?.variableValues?.tenant_slug) || (body.tenant_slug) || (typeof a==='object' ? a.tenant_slug : null) || (body.message?.toolCalls?.[0]?.function?.tenant_slug) || 'bus-tz-pawa';\n`;
  // Append tenant_slug to whatever object is returned. Match `return [{json:{...}}]`
  let out = code;
  const after = out.indexOf(";", out.indexOf("$input.first().json"));
  if (after !== -1) {
    out = out.slice(0, after + 1) + insertion + out.slice(after + 1);
  } else {
    out = insertion + out;
  }
  // Inject tenant_slug into the first "{json: {" object literal.
  out = out.replace(/return\s*\[\s*\{\s*json\s*:\s*\{/, m => m + `tenant_slug: tenantSlug, `);
  return out;
}

function nextParamIndex(query) {
  const matches = query.match(/\$(\d+)/g) || [];
  let max = 0;
  matches.forEach(m => { const n = parseInt(m.slice(1), 10); if (n > max) max = n; });
  return max + 1;
}

function tableInQuery(query) {
  const m = query.match(/\bfrom\s+(?:public\.)?(\w+)/i)
        || query.match(/\bjoin\s+(?:public\.)?(\w+)/i)
        || query.match(/\binto\s+(?:public\.)?(\w+)/i)
        || query.match(/\bupdate\s+(?:public\.)?(\w+)/i);
  return m ? m[1].toLowerCase() : null;
}

function tablesTouched(query) {
  const tables = new Set();
  const re = /\b(?:from|join|into|update)\s+(?:public\.)?(\w+)/gi;
  let m; while ((m = re.exec(query)) !== null) tables.add(m[1].toLowerCase());
  return tables;
}

function patchPostgresNode(node) {
  const params = node.parameters || {};
  const opts = params.options || {};
  let query = params.query || "";
  if (!query || query.includes(QUERY_MARKER)) return false;

  const touched = tablesTouched(query);
  const scoped = [...touched].filter(t => TENANT_TABLES.has(t));
  if (scoped.length === 0) return false;   // nothing to do (e.g. nearest_hubs only)

  let nextIdx = nextParamIndex(query);
  let mutated = false;

  // ---- INSERT INTO <table> (cols) VALUES (...) ----------
  query = query.replace(
    /INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    (m, tbl, cols, vals) => {
      if (!TENANT_TABLES.has(tbl.toLowerCase())) return m;
      if (/\btenant_slug\b/.test(cols)) return m;
      mutated = true;
      const newCols = cols.trimEnd() + ", tenant_slug";
      const newVals = vals.trimEnd() + `, $${nextIdx}`;
      nextIdx += 1;
      return `INSERT INTO ${tbl} (${newCols}) VALUES (${newVals})`;
    }
  );

  // ---- INSERT INTO <table> (cols) SELECT ... FROM ... ----------
  // CTE inserts: append tenant_slug column + literal to the SELECT list.
  query = query.replace(
    /INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^)]+)\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+/gi,
    (m, tbl, cols, selectList) => {
      if (!TENANT_TABLES.has(tbl.toLowerCase())) return m;
      if (/\btenant_slug\b/.test(cols)) return m;
      mutated = true;
      const newCols = cols.trimEnd() + ", tenant_slug";
      const newSel  = selectList.trimEnd() + `, $${nextIdx}`;
      nextIdx += 1;
      return `INSERT INTO ${tbl} (${newCols})\nSELECT ${newSel} FROM `;
    }
  );

  // ---- SELECT/UPDATE/DELETE ... [WHERE ...] -----------------
  // Goal: ensure a `tenant_slug = $N` predicate exists on any SELECT
  // touching a tenant-scoped table. If a WHERE exists, append it.
  // If not, insert one before ORDER BY / GROUP BY / LIMIT / RETURNING.
  if (!/\btenant_slug\b/.test(query) && /\b(SELECT|UPDATE|DELETE)\b/i.test(query)) {
    const whereRe = /\bWHERE\b/gi;
    let mm; let lastWhere = -1;
    while ((mm = whereRe.exec(query)) !== null) lastWhere = mm.index;

    const stopRe = /\b(?:ORDER\s+BY|GROUP\s+BY|LIMIT|RETURNING|FETCH)\b/i;

    if (lastWhere !== -1) {
      const tail = query.slice(lastWhere);
      const stopMatch = tail.match(stopRe);
      const stopAt = stopMatch ? lastWhere + stopMatch.index : query.length;
      const before = query.slice(0, stopAt).trimEnd();
      const after  = query.slice(stopAt);
      query = before + `\n  AND tenant_slug = $${nextIdx}\n` + after;
    } else {
      // No WHERE — wrap the table reference's tail with one.
      const stopMatch = query.match(stopRe);
      const stopAt = stopMatch ? stopMatch.index : query.length;
      const before = query.slice(0, stopAt).trimEnd();
      const after  = query.slice(stopAt);
      // Strip trailing semicolon from `before` if any (we'll re-add).
      const beforeNoSemi = before.replace(/;\s*$/, "");
      const trailing = before.length > beforeNoSemi.length ? ";" : "";
      query = beforeNoSemi + `\nWHERE tenant_slug = $${nextIdx}\n` + after + (trailing && !after.includes(";") ? "" : "");
    }
    nextIdx += 1;
    mutated = true;
  }

  // ---- WITH .. AS (SELECT ... WHERE ...) — covered by the above
  // because it just looks for the LAST WHERE, which is good enough for
  // the simple CTEs used in this workflow.

  if (!mutated) return false;

  params.query = query + "\n-- " + QUERY_MARKER;

  // queryReplacement: append the tenant_slug expression. n8n joins the
  // existing comma-separated string with our addition.
  const existing = (opts.queryReplacement || "").trim();
  const tenantExpr = "={{ $json.tenant_slug }}";
  opts.queryReplacement = existing ? `${existing},${tenantExpr}` : tenantExpr;
  params.options = opts;

  totalQueryEdits += 1;
  return true;
}

for (const file of FILES) {
  if (!fs.existsSync(file)) { console.warn("skip missing:", file); continue; }
  const wf = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(wf.nodes)) { console.warn("malformed:", file); continue; }

  let parseEdits = 0, queryEdits = 0, replEdits = 0;
  for (const node of wf.nodes) {
    if (node.type === "n8n-nodes-base.code") {
      const before = node.parameters?.jsCode || "";
      if (/parse|args/i.test(node.name) && /toolCalls|tool_calls|arguments/.test(before)) {
        const after = patchParseCode(before);
        if (after !== before) {
          node.parameters.jsCode = after;
          parseEdits += 1;
          totalParseEdits += 1;
        }
      }
    } else if (node.type === "n8n-nodes-base.postgres") {
      if (patchPostgresNode(node)) {
        queryEdits += 1;
      }
      const after = node.parameters?.options?.queryReplacement || "";
      if (after.includes("tenant_slug")) replEdits += 1;
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${path.basename(file)}: parseEdits=${parseEdits}, queryEdits=${queryEdits}, queryReplacement-with-tenant=${replEdits}`);
}

console.log(`TOTAL: parseEdits=${totalParseEdits}, queryEdits=${totalQueryEdits}`);
