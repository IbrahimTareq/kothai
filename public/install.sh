#!/bin/sh
# Kothai installer — https://github.com/IbrahimTareq/kothai
#
# Runs the container, waits until it actually serves, opens the browser.
#
# Asks two questions, and only two: where the AI should run, and which service
# if it is a hosted one. Those decide which image to pull, which is the one
# choice that cannot be deferred to a screen in the app. Everything else —
# the endpoint URL, the API key, the model names — is collected in the browser,
# where a pasted key does not end up in your shell history.
#
# The questions are read from /dev/tty, not stdin: the script's own stdin is
# the script when it arrives through a pipe, but the terminal is still there.
# With no terminal at all (CI, a Dockerfile, a NAS UI) it asks nothing and
# behaves exactly as it did before. So does any run that passes a flag which
# already answers a question.
#
# What it will not do is guess about your data — an existing container is
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
LOCAL=0
REPLACE=0
PROVIDER=
SHIM=1
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
    --lite            475 MB image, no on-device models
    --local           full image, models on this machine (skips the questions)
    --endpoint URL    OpenAI-compatible endpoint for language and vision
    --key KEY         API key for that endpoint, if it needs one
    --password VALUE  require a password before anything is served
    --replace         remove an existing container of the same name first
    --no-shim         skip installing the `kothai` command
    --tag TAG         image tag (default latest)
    -h, --help        this

  Passing any of --lite, --local or --endpoint answers the questions up front,
  so nothing is asked. With --endpoint on the full image, embedding stays on
  your machine and only the language and vision roles go out — most hosted
  endpoints serve no embeddings route, and semantic search needs one.
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
    --local) LOCAL=1; shift ;;
    --replace) REPLACE=1; shift ;;
    --no-shim) SHIM=0; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1  (--help for the list)" ;;
  esac
done

case $PORT in ''|*[!0-9]*) die "--port must be a number, got: $PORT" ;; esac
# Docker's own rule. Also what makes it safe to embed in the generated shim.
case $NAME in
  ''|*[!a-zA-Z0-9_.-]*) die "--name must be letters, digits, _ . or -, got: $NAME" ;;
esac
[ "$LITE" = 1 ] && [ "$LOCAL" = 1 ] && die "--lite and --local are opposites. Pick one."
[ "$LITE" = 1 ] && TAG=lite

# ---- the two questions ----------------------------------------------------
# Read from /dev/tty rather than stdin, because stdin is the script itself when
# this arrives through a pipe. Anything that makes asking impossible — no
# terminal, or a flag that already answers — falls through silently and leaves
# the historical behaviour exactly as it was.
#
# Only the IMAGE is decided here. The endpoint URL and the API key are not
# asked for on purpose: a key typed on a command line lands in shell history,
# and the browser is two seconds away.
ask() {
  printf '%s' "$1" > /dev/tty
  read -r REPLY < /dev/tty || REPLY=
  printf '%s' "$REPLY"
}

choose_setup() {
  # Already answered by a flag.
  [ -n "$ENDPOINT" ] && return 0
  [ "$LITE" = 1 ] && return 0
  [ "$LOCAL" = 1 ] && { PROVIDER=local; return 0; }
  # Nowhere to ask. Not an error: this is CI, a Dockerfile, or a NAS UI.
  #
  # Tested by actually OPENING it, in a subshell so a failure cannot take this
  # shell down with it. `[ -r /dev/tty ]` is not enough — on macOS the device
  # node exists and looks readable even when no terminal is attached, so the
  # test passes and the first prompt then dies on a redirect.
  ( : < /dev/tty ) 2>/dev/null || return 0

  printf '\n  Where should the AI run?\n\n' > /dev/tty
  printf '    1) A cloud service — nothing to download, needs an API key\n' > /dev/tty
  printf '    2) On this machine — private, no key, no bills, ~3 GB\n\n' > /dev/tty
  where=$(ask '  > ')

  # Anything unrecognised takes the on-machine path: it is what this installer
  # did before the question existed, and it needs nothing from the user.
  case $where in
    1) ;;
    *) PROVIDER=local; return 0 ;;
  esac

  printf '\n  Which one?\n\n' > /dev/tty
  printf '    1) OpenAI        — full search\n' > /dev/tty
  printf '    2) OpenRouter    — full search, many models behind one key\n' > /dev/tty
  printf '    3) Ollama Cloud  — chat only; keeps a small search model here\n' > /dev/tty
  printf '    4) Groq          — same\n' > /dev/tty
  printf '    5) Something else\n\n' > /dev/tty
  which=$(ask '  > ')

  # The image follows from whether the provider serves embeddings, which is the
  # whole reason this is asked in a terminal rather than in the browser. A
  # chat-only provider keeps the embedding model on this machine, and that
  # needs the full image; only a provider that serves embeddings can run lite.
  # Anything unrecognised gets the full image — the answer that always works.
  case $which in
    1) PROVIDER=openai;       TAG=lite ;;
    2) PROVIDER=openrouter;   TAG=lite ;;
    3) PROVIDER=ollama-cloud ;;
    4) PROVIDER=groq ;;
    *) PROVIDER=other ;;
  esac
  [ "$TAG" = lite ] && LITE=1
  return 0
}

choose_setup

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
# An id, never a credential: it only tells the first-run screen which questions
# have already been answered here.
[ -z "$PROVIDER" ] || set -- "$@" -e "STASH_SETUP_PROVIDER=$PROVIDER"
set -- "$@" "$IMAGE:$TAG"

say ""
say "Pulling $IMAGE:$TAG — this is the slow part."
docker "$@" >/dev/null || die "docker run failed. If the port is taken, try --port with a different number."

# ---- the `kothai` command -------------------------------------------------
# Generated rather than downloaded, so it carries this install's container name
# and nothing else. Deliberately no credentials: `kothai update` recovers the
# port, mounts and environment from the running container itself, so an API key
# passed to --key never gets copied into a file on PATH.
write_shim() {
  cat > "$1" <<SHIM_HEAD
#!/bin/sh
# kothai — generated by the Kothai installer. Safe to delete.
set -eu
NAME=$NAME
SHIM_HEAD
  cat >> "$1" <<'SHIM_BODY'
IMAGE=ghcr.io/ibrahimtareq/kothai

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }
exists() { docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = true ]; }
port() { docker inspect -f '{{(index (index .NetworkSettings.Ports "5173/tcp") 0).HostPort}}' "$NAME" 2>/dev/null || echo 5173; }
# Matched on destination, never on position: Docker lists the mounts in its own
# order, and it puts models first — so taking the first one calls the weights
# directory your data.
datadir() { docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$NAME" 2>/dev/null; }

wait_up() {
  i=0
  while [ "$i" -lt 60 ]; do
    curl -fsS "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 2
  done
  return 1
}

command -v docker >/dev/null 2>&1 || die "Docker is not installed."

case ${1:-help} in
  start)
    exists || die "No '$NAME' container. Re-run the installer to create one."
    running && { printf '  Already running — http://localhost:%s\n' "$(port)"; exit 0; }
    docker start "$NAME" >/dev/null
    p=$(port); wait_up "$p" || die "Started, but it never answered. Try: kothai logs"
    printf '  Ready — http://localhost:%s\n' "$p" ;;
  stop)
    running || die "'$NAME' is not running."
    docker stop "$NAME" >/dev/null; printf '  Stopped.\n' ;;
  restart)
    exists || die "No '$NAME' container."
    docker restart "$NAME" >/dev/null
    p=$(port); wait_up "$p" || die "Restarted, but it never answered. Try: kothai logs"
    printf '  Ready — http://localhost:%s\n' "$p" ;;
  status)
    exists || { printf '  Not installed.\n'; exit 1; }
    p=$(port)
    if running; then
      printf '  Running   http://localhost:%s\n' "$p"
      if curl -fsS "http://127.0.0.1:$p/api/health" >/dev/null 2>&1; then
        printf '  Serving   yes\n'
      else
        printf '  Serving   not yet — still starting, or check: kothai logs\n'
      fi
    else
      printf '  Stopped   start it with: kothai start\n'
    fi
    printf '  Image     %s\n' "$(docker inspect -f '{{.Config.Image}}' "$NAME")"
    printf '  Data      %s\n' "$(datadir)" ;;
  logs)
    exists || die "No '$NAME' container."
    shift; docker logs "$@" "$NAME" ;;
  update)
    exists || die "No '$NAME' container. Re-run the installer to create one."
    # Everything is read back off the container, so nothing had to be stored.
    img=$(docker inspect -f '{{.Config.Image}}' "$NAME")
    p=$(port)
    restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME")
    mounts=$(docker inspect -f '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}' "$NAME")
    envs=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | grep -E '^(STASH_|PORT=)' || true)
    printf '  Pulling %s…\n' "$img"
    docker pull "$img" >/dev/null || die "Pull failed."
    docker rm -f "$NAME" >/dev/null
    # shellcheck disable=SC2086
    set -- run -d --name "$NAME" --restart "${restart:-unless-stopped}" -p "$p:5173" $mounts
    for e in $envs; do set -- "$@" -e "$e"; done
    set -- "$@" "$img"
    docker "$@" >/dev/null || die "Could not recreate the container. Your data directory is untouched."
    wait_up "$p" || die "Updated, but it never answered. Try: kothai logs"
    printf '  Updated — http://localhost:%s\n' "$p" ;;
  uninstall)
    # The data directory is never touched: that is the whole archive.
    if exists; then
      d=$(datadir)
      docker rm -f "$NAME" >/dev/null
      printf '  Removed the container. Your data is still in %s\n' "$d"
    else
      printf '  No container to remove.\n'
    fi
    printf '  Delete this command with: rm %s\n' "$0" ;;
  -h|--help|help)
    cat <<'USAGE'
  kothai start | stop | restart | status | logs | update | uninstall

    start       start it (and wait until it serves)
    stop        stop it
    restart     restart it
    status      is it running, and where
    logs        docker logs — takes -f, --tail N, etc.
    update      pull the newest image and recreate, keeping your settings
    uninstall   remove the container; your data directory is left alone
USAGE
    ;;
  *) die "unknown command: $1  (kothai help)" ;;
esac
SHIM_BODY
  chmod 0755 "$1"
}

install_shim() {
  [ "$SHIM" = 1 ] || return 0
  # Never prompt for a password: piped into sh, a sudo prompt appears with no
  # context and no way to tell what is asking. Use a writable directory, or a
  # sudo that needs no password, or fall back to the user's own bin.
  if [ -w /usr/local/bin ] 2>/dev/null; then
    write_shim /usr/local/bin/kothai && say "Installed the 'kothai' command."
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    tmp=$(mktemp) && write_shim "$tmp" && sudo install -m 0755 "$tmp" /usr/local/bin/kothai && rm -f "$tmp" \
      && say "Installed the 'kothai' command."
  else
    mkdir -p "$HOME/.local/bin" && write_shim "$HOME/.local/bin/kothai" \
      && say "Installed the 'kothai' command to ~/.local/bin." \
      && case ":${PATH}:" in
        *":$HOME/.local/bin:"*) : ;;
        *) say "That is not on your PATH — add it, or run it as ~/.local/bin/kothai." ;;
      esac
  fi
}

# Best-effort, and never fatal: the URL is printed either way, and a headless
# box has nothing to open. Backgrounded so a slow-launching browser cannot hold
# up the installer's own exit.
open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  fi
  return 0
}

say "Waiting for it to come up…"
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say ""
    say "Ready — http://localhost:$PORT"
    [ -z "$PASSWORD" ] || say "Password: the one you passed to --password."
    case $PROVIDER in
      ''|local) say "Open it to choose your models." ;;
      *) say "Open it to paste your API key — that is the last step." ;;
    esac
    install_shim || true
    open_browser "http://localhost:$PORT"
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
