#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Cove — preflight checks.
#
#  The point of this script is that every failure prints a copy-pasteable fix
#  and names the exact thing that is wrong. Self-hosting goes wrong in a small
#  number of predictable ways; this is where we catch them before they turn
#  into a support conversation.
#
#  Usage:  ./scripts/doctor.sh        (or: pnpm doctor)
# ─────────────────────────────────────────────────────────────────────────────

# Deliberately not `set -e`: we want to run every check and report at the end.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PASS=0
WARN=0
FAIL=0

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_B=''; C_0=''
fi

ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$1"; PASS=$((PASS + 1)); }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_0" "$1"; [ -n "${2:-}" ] && printf '      %s%s%s\n' "$C_DIM" "$2" "$C_0"; WARN=$((WARN + 1)); }
bad()  { printf '  %s✗%s %s\n' "$C_ERR" "$C_0" "$1"; [ -n "${2:-}" ] && printf '      %s%s%s\n' "$C_DIM" "$2" "$C_0"; FAIL=$((FAIL + 1)); }
section() { printf '\n%s%s%s\n' "$C_B" "$1" "$C_0"; }

printf '%sCove doctor%s\n' "$C_B" "$C_0"
printf '%s%s%s\n' "$C_DIM" "checking this machine for what the stack needs" "$C_0"

# ─────────────────────────── container runtime ───────────────────────────────
section "Container runtime"

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
  ok "podman $(podman --version 2>/dev/null | awk '{print $3}')"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
  ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
else
  bad "neither podman nor docker found" \
      "Fedora:  sudo dnf install podman podman-compose
Debian:  sudo apt install podman podman-compose"
fi

# ─────────────────────────── compose provider ────────────────────────────────
# This is the single most common first-run failure on Fedora: `podman` is
# installed but no compose provider is, so `podman compose up` dies with a
# confusing "looking up compose provider failed".
section "Compose provider"

COMPOSE_CMD=""
if [ "$RUNTIME" = "podman" ]; then
  if podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD="podman compose"
    ok "podman compose (external provider present)"
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE_CMD="podman-compose"
    ok "podman-compose $(podman-compose --version 2>/dev/null | head -1)"
  else
    bad "podman is installed but no compose provider is" \
        "Fedora:  sudo dnf install podman-compose
   or:  pipx install podman-compose
   or:  install the docker-compose CLI plugin into ~/.docker/cli-plugins/
Note: this is exactly the state this machine shipped in, so it is worth fixing once."
  fi
elif [ "$RUNTIME" = "docker" ]; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    ok "docker compose plugin"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    ok "docker-compose (legacy binary)"
  else
    bad "docker is installed but the compose plugin is not" \
        "Install the docker-compose-plugin package for your distro."
  fi
fi

# ─────────────────────────────── configuration ───────────────────────────────
section "Configuration"

if [ -f .env ]; then
  ok ".env exists"
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
else
  bad ".env is missing" "Run ./setup.sh — it generates one with real secrets."
fi

secret_len() { printf '%s' "${1:-}" | wc -c | tr -d ' '; }

if [ "$(secret_len "${COVE_SESSION_SECRET:-}")" -ge 32 ]; then
  ok "COVE_SESSION_SECRET is set (>=32 chars)"
else
  bad "COVE_SESSION_SECRET is missing or too short" "openssl rand -hex 32"
fi

if [ -n "${COVE_SITE_URL:-}" ]; then
  ok "COVE_SITE_URL = ${COVE_SITE_URL}"
  case "${COVE_SITE_URL}" in
    *localhost*|*127.0.0.1*)
      warn "site URL is localhost, so federation will not work" \
           "Federated identities are URLs. Set a real domain before Phase 5." ;;
  esac
else
  bad "COVE_SITE_URL is unset" "e.g. https://cove.example.com"
fi

if [ -n "${COVE_HANDLE:-}" ]; then
  ok "handle = @${COVE_HANDLE}"
else
  warn "COVE_HANDLE is unset" "This becomes your @handle@domain identity."
fi

if [ -n "${POSTGRES_PASSWORD:-}" ] && [ "${POSTGRES_PASSWORD}" != "change-me" ]; then
  ok "POSTGRES_PASSWORD is set"
else
  bad "POSTGRES_PASSWORD is unset or still 'change-me'" "Run ./setup.sh to generate one."
fi

# ───────────────────────────────── ports ─────────────────────────────────────
section "Ports"

port_in_use() {
  # ss ships with iproute2, which every target distro has.
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$1" 2>/dev/null | grep -q . && return 0
    return 1
  fi
  return 1
}

# Only complain about 80/443 if something *else* already holds them. If our own
# stack is up, holding them is correct.
for p in 80 443; do
  if port_in_use "$p"; then
    if [ -n "$COMPOSE_CMD" ] && $COMPOSE_CMD ps --status running 2>/dev/null | grep -q caddy; then
      ok "port $p held by Cove's own caddy"
    else
      bad "port $p is already in use" "Stop whatever holds it, or change the caddy ports in compose.yaml."
    fi
  else
    ok "port $p is free"
  fi
done

if [ "${COVE_LIVE_ENABLED:-false}" = "true" ]; then
  section "Live streaming ports (COVE_LIVE_ENABLED=true)"
  for p in 1935 8888 8889 9996; do
    port_in_use "$p" && warn "tcp/$p already in use" || ok "tcp/$p free"
  done
  ok "udp/8189 — cannot be checked from here; must reach the host directly"
  warn "WebRTC media bypasses the reverse proxy" \
       "Open udp/8189 in your firewall, and set MTX_WEBRTCADDITIONALHOSTS to your public IP behind NAT.
Fedora:  sudo firewall-cmd --add-port=8189/udp --permanent && sudo firewall-cmd --reload"
fi

# ─────────────────────────────────── disk ────────────────────────────────────
section "Storage"

DATA_DIR="${COVE_DATA_DIR:-/data}"
HOST_DATA_DIR="./data"
mkdir -p "$HOST_DATA_DIR" 2>/dev/null || true

FREE_MB=$(df -Pm "$HOST_DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${FREE_MB:-}" ]; then
  FREE_GB=$((FREE_MB / 1024))
  MIN_MB="${COVE_MIN_FREE_MB:-2048}"
  if [ "$FREE_MB" -lt "$MIN_MB" ]; then
    bad "only ${FREE_GB} GB free at ${HOST_DATA_DIR}" \
        "Cove refuses to start a transcode below COVE_MIN_FREE_MB=${MIN_MB} MB. Free some space."
  else
    ok "${FREE_GB} GB free at ${HOST_DATA_DIR} (container path: ${DATA_DIR})"
  fi
  if [ "$FREE_MB" -lt 20480 ]; then
    warn "under 20 GB free — that is a few hours of 1080p recording" \
         "Recordings are the fastest way to fill a disk. Set a retention policy."
  fi
else
  warn "could not determine free space at ${HOST_DATA_DIR}"
fi

# ──────────────────────────────── hardware ───────────────────────────────────
section "Hardware & suggested preset"

CORES=$(nproc 2>/dev/null || echo 1)
if [ -r /proc/meminfo ]; then
  RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
else
  RAM_MB=0
fi
RAM_GB=$((RAM_MB / 1024))

ok "${CORES} CPU cores, ${RAM_GB} GB RAM"

SUGGESTED="balanced"
if [ "$CORES" -le 2 ] || [ "$RAM_GB" -lt 4 ]; then
  SUGGESTED="remux-first"
elif [ "$CORES" -le 4 ]; then
  SUGGESTED="low-power"
elif [ "$CORES" -ge 8 ] && [ "$RAM_GB" -ge 16 ]; then
  SUGGESTED="quality"
fi

if [ "${COVE_POWER_PRESET:-balanced}" = "$SUGGESTED" ]; then
  ok "COVE_POWER_PRESET=${COVE_POWER_PRESET} suits this machine"
else
  warn "COVE_POWER_PRESET=${COVE_POWER_PRESET:-balanced}, but '${SUGGESTED}' suits this machine better" \
       "Transcoding is the expensive part. Change it in .env if encodes feel too slow or too costly."
fi

# Hardware video encoders, if the host exposes them.
if [ -e /dev/dri/renderD128 ]; then
  ok "/dev/dri present — Intel/AMD hardware encoding may be available"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  ok "NVIDIA GPU detected — NVENC available"
fi

# ──────────────────────────────── host ffmpeg ────────────────────────────────
section "Media tooling"

# Cove never uses the host's ffmpeg in production — the worker image bakes its
# own. We only check the host so that local development is not silently broken.
if command -v ffmpeg >/dev/null 2>&1; then
  FFVER=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then
    ok "host ffmpeg ${FFVER} with libx264 (dev only — production uses the worker image)"
  else
    warn "host ffmpeg ${FFVER} has no libx264" \
         "Cove does not use host ffmpeg, so this only affects local dev outside the container.
Fedora ships ffmpeg-free without libx264: enable RPM Fusion and install 'ffmpeg'.
Alternatively run the worker container, which always has a known-good build."
  fi
else
  warn "no host ffmpeg (fine — the worker image provides its own)" \
       "Only needed if you run the worker outside a container."
fi

# ──────────────────────────────── SELinux ────────────────────────────────────
if command -v getenforce >/dev/null 2>&1; then
  section "SELinux"
  MODE=$(getenforce 2>/dev/null || echo Unknown)
  case "$MODE" in
    Enforcing)
      ok "Enforcing — Cove labels its bind mounts with :Z so containers may write"
      ;;
    Permissive)
      warn "Permissive — mounts work, but the host is not protected"
      ;;
    *)
      ok "mode: ${MODE}"
      ;;
  esac
fi

# ──────────────────────────────── connectivity ───────────────────────────────
if [ -n "$COMPOSE_CMD" ] && $COMPOSE_CMD ps 2>/dev/null | grep -q .; then
  section "Running stack"
  if $COMPOSE_CMD ps 2>/dev/null | grep -q db; then
    ok "db service present"
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 http://localhost:3000/healthz >/dev/null 2>&1; then
      ok "web responds on :3000"
    elif curl -fsS --max-time 5 http://localhost/healthz >/dev/null 2>&1; then
      ok "web responds through caddy on :80"
    else
      warn "stack is running but the web app did not answer" \
           "Check logs: $COMPOSE_CMD logs web"
    fi
  fi
fi

# ────────────────────────────────── summary ──────────────────────────────────
printf '\n%s────────────────────────────────────────%s\n' "$C_DIM" "$C_0"
printf '%s%d passed, %d warnings, %d problems%s\n' "$C_B" "$PASS" "$WARN" "$FAIL" "$C_0"

if [ "$FAIL" -gt 0 ]; then
  printf '\n%sFix the %d problem(s) above, then run this again.%s\n' "$C_ERR" "$FAIL" "$C_0"
  exit 1
fi

if [ "$WARN" -gt 0 ]; then
  printf '\n%sWarnings are not blockers — read them before going public.%s\n' "$C_WARN" "$C_0"
fi

if [ -n "$COMPOSE_CMD" ]; then
  printf '\n%sReady. Start Cove with:%s  %s up -d\n' "$C_OK" "$C_0" "$COMPOSE_CMD"
else
  printf '\n%sInstall a compose provider first (see above).%s\n' "$C_WARN" "$C_0"
fi
