# Pawa map gateway — container image.
#
# Multi-stage: compile a static binary, then ship it on a tiny distroless base
# that still includes CA certificates (needed for the HTTPS calls to Nominatim).
# The service reads $PORT (Render / Cloud Run / Fly all inject it) and binds all
# interfaces, so it runs unchanged on any of them.
#
# Build context must be this directory (services/go).

# ---- build ----------------------------------------------------------------
FROM golang:1.26 AS build
WORKDIR /src
# No third-party deps (stdlib only) — copy go.mod then the sources.
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /gateway .

# ---- run ------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /gateway /gateway
# Default port; hosting platforms override PORT at runtime.
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
