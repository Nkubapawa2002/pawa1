# Pawa python service — AI search brain + video faststart remux.
#
# Stdlib-only Python, plus the `ffmpeg` binary for the /faststart endpoint
# (lossless `-movflags +faststart` remux so uploaded house videos stream
# without stutter). Reads $PORT (Render/Cloud Run/Fly inject it) and binds all
# interfaces via HOST=0.0.0.0.
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
