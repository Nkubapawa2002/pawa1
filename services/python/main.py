"""Pawa "python" service stub.

Role in the polyglot stack: AI reasoning & LLM orchestration, agents, ML, data
wrangling, geocoding, scraping, and admin/automation scripts. This is the
default home for the "reasoning" layer. See ../../docs/LANGUAGE-ROUTING.md.

Dependency-free: standard library only.
Run with:  uv run main.py   (or)   python main.py
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8094"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server API name
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(
            {
                "lang": "python",
                "status": "ok",
                "role": "AI reasoning / ML / data / scripting",
                "port": PORT,
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # silence default request logging
        pass


def main() -> None:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"python service listening on http://127.0.0.1:{PORT}/health")
    server.serve_forever()


if __name__ == "__main__":
    main()
