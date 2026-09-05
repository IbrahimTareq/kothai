#!/bin/sh
# Kothai installer — https://github.com/IbrahimTareq/kothai
#
# Runs the container, waits until it actually serves, and prints the URL.
# It asks nothing: piped into sh there is no terminal to ask on, and every
# choice it would have asked about is either a flag here or a screen in the
# app. What it will not do is guess about your data — an existing container is
# reported, never replaced, unless you say --replace.
#
#   curl -fsSL https://ibrahimtareq.github.io/kothai/install.sh | sh
#   curl -fsSL https://ibrahimtareq.github.io/kothai/install.sh | sh -s -- --port 8080
set -eu

IMAGE=ghcr.io/ibrahimtareq/kothai
TAG=latest
NAME=kothai
PORT=5173
DIR=$(pwd)
LITE=0
REPLACE=0
ENDPOINT=
APIKEY=
PASSWORD=

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

usage() {
  cat <<'USAGE'
  Kothai installer

    --port N          host port to serve on (default 5173)
    --dir PATH        where data and models live (default: current directory)
    --name NAME       container name (default kothai)
    --lite            250 MB image, no on-device models; needs --endpoint
    --endpoint URL    OpenAI-compatible endpoint for language and vision
    --key KEY         API key for that endpoint, if it needs one
    --password VALUE  require a password before anything is served
    --replace         remove an existing container of the same name first
    --tag TAG         image tag (default latest)
    -h, --help        this

  With --endpoint on the full image, embedding stays on your machine and only
  the language and vision roles go out — most hosted endpoints serve no
  embeddings route, and semantic search needs one.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case $1 in
    --port) PORT=${2:?--port needs a value}; shift 2 ;;
    --dir) DIR=${2:?--dir needs a value}; shift 2 ;;
    --name) NAME=${2:?--name needs a value}; shift 2 ;;
    --tag) TAG=${2:?--tag needs a value}; shift 2 ;;
    --endpoint) ENDPOINT=${2:?--endpoint needs a value}; shift 2 ;;
    --key) APIKEY=${2:?--key needs a value}; shift 2 ;;
    --password) PASSWORD=${2:?--password needs a value}; shift 2 ;;
    --lite) LITE=1; shift ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1  (--help for the list)" ;;
  esac
done

case $PORT in ''|*[!0-9]*) die "--port must be a number, got: $PORT" ;; esac
[ "$LITE" = 1 ] && [ -z "$ENDPOINT" ] && die "--lite runs no models itself, so it needs --endpoint. See --help."
[ "$LITE" = 1 ] && TAG=lite

command -v docker >/dev/null 2>&1 || die "Docker is not installed — https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and try again."

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  [ "$REPLACE" = 1 ] || die "A container named '$NAME' already exists. Re-run with --replace to recreate it (your data in $DIR is untouched), or use --name for a second install."
  say "Removing the existing '$NAME' container — data in $DIR is left alone."
  docker rm -f "$NAME" >/dev/null
fi

mkdir -p "$DIR/data" || die "Cannot write to $DIR"
[ "$LITE" = 1 ] || mkdir -p "$DIR/models"

set -- run -d --name "$NAME" --restart unless-stopped -p "$PORT:5173" -v "$DIR/data:/app/data"
[ "$LITE" = 1 ] || set -- "$@" -v "$DIR/models:/app/models"
[ -z "$ENDPOINT" ] || set -- "$@" -e STASH_AI_PROVIDER=remote -e "STASH_AI_BASE_URL=$ENDPOINT"
[ -z "$APIKEY" ] || set -- "$@" -e "STASH_AI_API_KEY=$APIKEY"
[ -z "$PASSWORD" ] || set -- "$@" -e "STASH_PASSWORD=$PASSWORD"
set -- "$@" "$IMAGE:$TAG"

say ""
say "Pulling $IMAGE:$TAG — this is the slow part."
docker "$@" >/dev/null || die "docker run failed. If the port is taken, try --port with a different number."

say "Waiting for it to come up…"
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say ""
    say "Ready — http://localhost:$PORT"
    [ -z "$PASSWORD" ] || say "Password: the one you passed to --password."
    say "Open it to choose your models."
    say ""
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

# A wait loop that reports only "timed out" sends you diagnosing the wrong
# thing, so hand over the container's own logs.
printf '\n  It did not answer within two minutes. Container logs:\n\n' >&2
docker logs --tail 40 "$NAME" >&2 || true
exit 1
