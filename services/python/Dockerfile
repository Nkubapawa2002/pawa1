# Pawa python service — AI search brain + video normalise.
#
# Stdlib-only Python, plus the `ffmpeg` package for /normalize (and its older
# alias /faststart):
#   · ffmpeg  — trims to the 2m39s cap and does the lossless
#               `-movflags +faststart` remux so uploads stream without stutter
#   · ffprobe — measures the duration. Shipped in the same Debian `ffmpeg`
#               package, and NOT optional: without it main.py cannot tell how
#               long a clip is, so it silently stops enforcing the cap and
#               /health reports "trim": "no_ffprobe".
#
# Reads $PORT (Render/Cloud Run/Fly inject it) and binds all interfaces via
# HOST=0.0.0.0.
#
# Build context must be this directory (services/python).

FROM python:3.12-slim

# ffmpeg is the only system dependency; --no-install-recommends keeps it lean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY main.py ./

ENV HOST=0.0.0.0 \
    PORT=8080 \
    PYTHONUNBUFFERED=1
EXPOSE 8080

# ANTHROPIC_API_KEY is optional (ai-search returns 503 without it); faststart
# needs no secrets. Set keys via the platform's env/secrets, not in this image.
CMD ["python", "main.py"]
