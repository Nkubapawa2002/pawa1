#!/usr/bin/env python3
"""One-off: remux every existing house video to MP4 "faststart" in place.

Phone/Windows recorders write the MP4 `moov` index at the END of the file, so a
browser must download the whole clip before it plays/seeks smoothly — the video
stutters. This script finds every video referenced by the `houses` table,
downloads it, and — if it isn't already faststart — runs a lossless
`ffmpeg -c copy -movflags +faststart` remux and overwrites it in the storage
bucket. New uploads are handled live by services/python (/faststart); this fixes
the ones uploaded before that existed.

Requirements:
    - ffmpeg on PATH
    - env SUPABASE_URL                (e.g. https://xxxx.supabase.co)
    - env SUPABASE_SERVICE_ROLE_KEY   (Settings → API → service_role; NOT anon)
      The service-role key is needed to overwrite objects; keep it out of git.

Usage (PowerShell):
    $env:SUPABASE_URL = "https://kkdpacoiwntrcukgwksh.supabase.co"
    $env:SUPABASE_SERVICE_ROLE_KEY = "<service_role_key>"
    python scripts/faststart_backfill.py            # process and overwrite
    python scripts/faststart_backfill.py --dry-run  # report only, change nothing
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

BUCKET = os.environ.get("HOUSE_PHOTOS_BUCKET", "house-photos")
DRY_RUN = "--dry-run" in sys.argv


def _env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"Missing required env var: {name}")
    return v


SB = _env("SUPABASE_URL").rstrip("/")
KEY = _env("SUPABASE_SERVICE_ROLE_KEY")


def _req(url: str, *, method: str = "GET", data: bytes | None = None,
         headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def list_video_paths() -> list[str]:
    """Every distinct, bucket-stored video path across all houses."""
    url = f"{SB}/rest/v1/houses?select=videos&videos=neq.%7B%7D"
    rows = json.loads(_req(url, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}))
    paths: list[str] = []
    seen = set()
    for row in rows:
        for p in (row.get("videos") or []):
            if p and not p.startswith(("http", "data/")) and p not in seen:
                seen.add(p)
                paths.append(p)
    return paths


def is_faststart(data: bytes) -> bool:
    moov = data.find(b"moov")
    if moov == -1:
        return False
    mdat = data.find(b"mdat")
    return mdat == -1 or moov < mdat


def remux(data: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in"), os.path.join(d, "out.mp4")
        with open(src, "wb") as f:
            f.write(data)
        subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-c", "copy", "-movflags", "+faststart",
             "-f", "mp4", dst],
            check=True, capture_output=True, timeout=300,
        )
        with open(dst, "rb") as f:
            return f.read()


def download(path: str) -> bytes:
    return _req(f"{SB}/storage/v1/object/public/{BUCKET}/{path}")


def overwrite(path: str, data: bytes) -> None:
    # PUT = update an existing object; x-upsert tolerates either state.
    _req(
        f"{SB}/storage/v1/object/{BUCKET}/{path}",
        method="PUT",
        data=data,
        headers={
            "apikey": KEY,
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "video/mp4",
            "x-upsert": "true",
        },
    )


def main() -> None:
    paths = list_video_paths()
    print(f"Found {len(paths)} video(s).{'  [DRY RUN]' if DRY_RUN else ''}\n")
    fixed = skipped = failed = 0
    for p in paths:
        try:
            data = download(p)
            if is_faststart(data):
                print(f"  [ok]   already faststart   {p}")
                skipped += 1
                continue
            out = remux(data)
            saved = len(data) - len(out)
            if DRY_RUN:
                print(f"  [plan] would remux ({len(data)//1024} KB -> {len(out)//1024} KB)  {p}")
            else:
                overwrite(p, out)
                print(f"  [fix]  remuxed ({len(data)//1024} KB -> {len(out)//1024} KB, saved {saved//1024} KB)  {p}")
            fixed += 1
        except subprocess.CalledProcessError as e:
            print(f"  [FAIL] ffmpeg            {p}\n    {e.stderr.decode(errors='replace')[:300]}")
            failed += 1
        except urllib.error.HTTPError as e:
            print(f"  [FAIL] HTTP {e.code}         {p}\n    {e.read().decode(errors='replace')[:300]}")
            failed += 1
        except Exception as e:  # noqa: BLE001
            print(f"  [FAIL] {type(e).__name__}: {e}    {p}")
            failed += 1

    verb = "would fix" if DRY_RUN else "fixed"
    print(f"\nDone. {verb}={fixed}  already-ok={skipped}  failed={failed}")


if __name__ == "__main__":
    main()
