"""Pawa "python" service — AI search brain (self-host / local alternative).

Role in the polyglot stack: AI reasoning & LLM orchestration. This is the
designated "reasoning" home (see ../../docs/LANGUAGE-ROUTING.md). It implements
the SAME JSON contract as the Supabase Edge Function `ai-search`, so the static
frontend (js/ai-search.js) can talk to either one — just point
APP_CONFIG.AI_SEARCH_URL at this server, e.g. "http://127.0.0.1:8094/ai-search".

It turns a free-text housing / ride / "near me" question (English or Swahili)
into one structured intent object the frontend's existing engines consume.

"Just add the key":
    # PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."
    # bash:        export ANTHROPIC_API_KEY=sk-ant-...
    uv run main.py          # or: python main.py
Without the key it still serves /health and returns a clear 503 on /ai-search,
so nothing crashes — the frontend just falls back to its regex parser.

Dependency-free: standard library only (urllib for the Anthropic call).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8094"))

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
DEFAULT_MAX_TOKENS = 700

# Keep this prompt in lockstep with supabase/functions/ai-search/index.ts.
SYSTEM_PROMPT = """You are the search-intent parser for Pawa, a Tanzania (TZ) housing + ride-hailing app used in English and Swahili. Convert the user's free-text request into ONE JSON object. Output the JSON only — no prose, no code fences.

Shape (always return every key; use null / [] when not stated):
{
  "domain": "house" | "ride" | "unknown",
  "answer": string,
  "nearMe": boolean,
  "place": { "name": string } | null,
  "house": {
    "listing": "rent" | "sale" | null,
    "type": "apartment" | "house" | "plot" | "office" | null,
    "bedrooms": number | null,
    "bathrooms": number | null,
    "area": string | null,
    "priceMax": number | null,
    "priceMin": number | null,
    "amenities": string[],
    "keywords": string[]
  },
  "ride": {
    "vehicleType": string | null,
    "pickup":  { "name": string } | null,
    "dropoff": { "name": string } | null,
    "when": string | null
  }
}

Rules:
- "house" = a place to live/rent/buy; "ride" = getting a car/bajaji/bodaboda or going somewhere; unclear => "unknown".
- TZS money: expand shorthand to full integers ("500k"=500000, "1.5m"=1500000, "2bn"=2000000000). "under/below/up to" => priceMax; "over/from/at least" => priceMin; a bare budget => priceMax.
- Never output coordinates — only spoken names in place/pickup/dropoff (the app geocodes them, TZ-only).
- "near me"/"karibu nami"/"nearby" with no named place => nearMe=true, place=null (rides: pickup=null = use GPS).
- Snap area to the supplied areas whitelist when given; snap vehicleType to the vehicleTypes whitelist when given.
- "answer" = one short sentence in the user's language (Swahili if the query is Swahili).
- Neither housing nor ride => domain="unknown"."""

_FALLBACK = {
    "domain": "unknown", "answer": "Could not understand the request.",
    "nearMe": False, "place": None,
    "house": {"listing": None, "type": None, "bedrooms": None, "bathrooms": None,
              "area": None, "priceMax": None, "priceMin": None, "amenities": [], "keywords": []},
    "ride": {"vehicleType": None, "pickup": None, "dropoff": None, "when": None},
}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}


def _build_user_message(body: dict) -> str:
    lines = [f"Query: {body.get('query', '')}"]
    origin = body.get("origin") or {}
    try:
        lat, lng = float(origin["lat"]), float(origin["lng"])
        lines.append(f"User current location (lat,lng): {lat}, {lng}")
    except (KeyError, TypeError, ValueError):
        pass
    areas = body.get("areas")
    if isinstance(areas, list) and areas:
        lines.append("Known areas (snap to one when relevant): " + ", ".join(map(str, areas[:200])))
    vts = body.get("vehicleTypes")
    if isinstance(vts, list) and vts:
        lines.append("Ride vehicle types: " + ", ".join(map(str, vts)))
    if body.get("lang") in ("sw", "en"):
        lines.append(f"UI language: {body['lang']}")
    return "\n".join(lines)


def _call_anthropic(api_key: str, body: dict) -> dict:
    """Call Claude, return {ok, intent|error, ...}. Raises nothing — returns dict."""
    payload = {
        "model": body.get("model") or DEFAULT_MODEL,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "temperature": 0.1,
        "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": _build_user_message(body)}],
    }
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        return {"_status": e.code, "error": "anthropic_error", "detail": detail}
    except Exception as e:  # noqa: BLE001 - network/timeout/parse
        return {"_status": 502, "error": "anthropic_unreachable", "detail": str(e)}

    raw = "\n".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    ).strip()
    intent = None
    match = re.search(r"\{[\s\S]*\}", raw)
    if match:
        try:
            intent = json.loads(match.group(0))
        except json.JSONDecodeError:
            intent = None
    if intent is None:
        intent = dict(_FALLBACK, answer=raw or _FALLBACK["answer"])

    return {
        "ok": True, "intent": intent, "raw": raw,
        "model": data.get("model", payload["model"]), "usage": data.get("usage"),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server API name
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {
                "lang": "python", "status": "ok",
                "role": "AI reasoning — ai-search brain",
                "ai_search": "ready" if os.environ.get("ANTHROPIC_API_KEY") else "no_key",
                "port": PORT,
            })
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        # Accept the path the frontend uses (/functions/v1/ai-search), a short
        # /ai-search, or bare / — all mean "parse this query".
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            body = json.loads(self.rfile.read(length).decode() or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"error": "invalid_json"})

        if not isinstance(body, dict) or not str(body.get("query", "")).strip():
            return self._send(400, {"error": "query_required"})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._send(503, {"error": "anthropic_key_missing"})

        result = _call_anthropic(api_key, body)
        status = result.pop("_status", 200)
        self._send(status, result)

    def log_message(self, *_args) -> None:  # silence default request logging
        pass


def main() -> None:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    key_state = "key set ✓" if os.environ.get("ANTHROPIC_API_KEY") else "NO KEY — set ANTHROPIC_API_KEY"
    print(f"python ai-search listening on http://127.0.0.1:{PORT}  ({key_state})")
    print(f"  health: GET  http://127.0.0.1:{PORT}/health")
    print(f"  search: POST http://127.0.0.1:{PORT}/ai-search")
    server.serve_forever()


if __name__ == "__main__":
    main()
