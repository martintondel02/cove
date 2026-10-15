#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Cove — first-run setup.
#
#  Asks a handful of questions, generates real secrets, writes .env, and runs
#  the preflight checks. The goal is that nobody ever hand-edits a YAML file to
#  get Cove running: that is the whole "self-hosting is a feature" contract
#  from docs/PLAN.md §9.
#
#  Usage:
#    ./setup.sh                    interactive
#    ./setup.sh --yes              accept defaults (for CI / scripted installs)
#    ./setup.sh --force            overwrite an existing .env
#
#  Any prompt can also be answered ahead of time via the environment:
#    COVE_SITE_URL=https://cove.example.com ./setup.sh --yes
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ASSUME_YES=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_B=''; C_0=''
fi

say()  { printf '%s\n' "$1"; }
note() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_0"; }
good() { printf '%s✓%s %s\n' "$C_OK" "$C_0" "$1"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_0" "$1"; }
die()  { printf '%s✗ %s%s\n' "$C_ERR" "$1" "$C_0" >&2; exit 1; }

# Interactive only when we have a terminal and were not told to assume.
INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then INTERACTIVE=1; fi

ask() { # ask <var-name> <prompt> <default>
  local __var="$1" __prompt="$2" __default="$3" __reply=""
  local __prefilled="${!__var:-}"
  if [ -n "$__prefilled" ]; then printf '%s' "$__prefilled"; return; fi
  if [ "$INTERACTIVE" -eq 0 ]; then printf '%s' "$__default"; return; fi
  printf '%s' "$__prompt" >&2
  [ -n "$__default" ] && printf ' %s[%s]%s' "$C_DIM" "$__default" "$C_0" >&2
  printf ': ' >&2
  read -r __reply || true
  printf '%s' "${__reply:-$__default}"
}

ask_yes_no() { # ask_yes_no <var> <prompt> <default: y|n>
  local __var="$1" __prompt="$2" __default="$3"
  local __prefilled="${!__var:-}"
  local __answer
  if [ -n "$__prefilled" ]; then __answer="$__prefilled"
  elif [ "$INTERACTIVE" -eq 0 ]; then __answer="$__default"
  else
    printf '%s' "$__prompt" >&2
    printf ' %s[%s]%s: ' "$C_DIM" "$__default" "$C_0" >&2
    read -r __answer || true
    __answer="${__answer:-$__default}"
  fi
  case "$__answer" in y|Y|yes|YES|true|1) printf 'true' ;; *) printf 'false' ;; esac
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

printf '\n%sCove setup%s\n' "$C_B" "$C_0"
note "A few questions, then you are running. Press enter to accept a default."

# ── refuse to clobber an existing config without permission ─────────────────
if [ -f .env ] && [ "$FORCE" -eq 0 ]; then
  printf '\n'
  warn ".env already exists."
  note "Re-running setup would rotate your secrets, which invalidates existing sessions."
  if [ "$INTERACTIVE" -eq 1 ]; then
    printf 'Overwrite it? [y/N]: '
    read -r reply || true
    case "$reply" in
      y|Y|yes) ;;
      *) note "Keeping the existing .env. Running the preflight checks instead."
         printf '\n'; exec ./scripts/doctor.sh ;;
    esac
  else
    note "Keeping the existing .env (use --force to overwrite)."
    printf '\n'; exec ./scripts/doctor.sh
  fi
fi

printf '\n%sIdentity%s\n' "$C_B" "$C_0"
note "These three values decide your federated identity (@handle@domain),"
note "which is why they are asked first — they are permanent once followed."

DEFAULT_URL="http://localhost:${COVE_HTTP_PORT:-8080}"
SITE_URL="$(ask COVE_SITE_URL "Public URL of your site?" "$DEFAULT_URL")"
case "$SITE_URL" in
  http://*|https://*) ;;
  *) SITE_URL="https://${SITE_URL}" ;;
esac
SITE_URL="${SITE_URL%/}"

DOMAIN="$(printf '%s' "$SITE_URL" | sed -E 's#^https?://##; s#/.*$##; s#:.*$##')"
DEFAULT_HANDLE="me"
HANDLE="$(ask COVE_HANDLE "Your handle (the 'you' in @you@domain)?" "$DEFAULT_HANDLE")"

SITE_NAME="$(ask COVE_SITE_NAME "Site name?" "Cove")"
SITE_TAGLINE="$(ask COVE_SITE_TAGLINE "Tagline?" "A quiet corner of the internet.")"

# ── power preset, suggested from the actual hardware ────────────────────────
CORES=$(nproc 2>/dev/null || echo 1)
RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
RAM_GB=$((RAM_MB / 1024))
SUGGESTED="balanced"
if [ "$CORES" -le 2 ] || [ "$RAM_GB" -lt 4 ]; then SUGGESTED="remux-first"
elif [ "$CORES" -le 4 ]; then SUGGESTED="low-power"
elif [ "$CORES" -ge 8 ] && [ "$RAM_GB" -ge 16 ]; then SUGGESTED="quality"; fi

printf '\n%sMedia%s\n' "$C_B" "$C_0"
note "Your machine has ${CORES} cores and ${RAM_GB} GB RAM."
note "remux-first  never re-encodes — fastest, Pi-friendly"
note "low-power    one 720p rendition"
note "balanced     720p + 480p"
note "quality      full 1080p/720p/480p ladder"
POWER="$(ask COVE_POWER_PRESET "Transcoding preset?" "$SUGGESTED")"
case "$POWER" in
  remux-first|low-power|balanced|quality) ;;
  *) warn "'${POWER}' is not a known preset; using '${SUGGESTED}'."; POWER="$SUGGESTED" ;;
esac

printf '\n%sOptional features%s\n' "$C_B" "$C_0"
LIVE="$(ask_yes_no COVE_LIVE_ENABLED "Enable livestreaming (adds an opt-in container and open ports)?" "n")"
FED="$(ask_yes_no COVE_FEDERATION_ENABLED "Enable outbound federation to the fediverse (Phase 5)?" "n")"

VISIBILITY="public"
if [ "$INTERACTIVE" -eq 1 ]; then
  printf '\n%sVisibility%s\n' "$C_B" "$C_0"
  note "public    anyone can browse the site"
  note "unlisted  only people with a link"
  note "password  a shared password gate"
  VISIBILITY="$(ask COVE_VISIBILITY "Who can see your site?" "public")"
  case "$VISIBILITY" in public|unlisted|password) ;; *) VISIBILITY="public" ;; esac
fi

# ── generate secrets ────────────────────────────────────────────────────────
printf '\n%sGenerating secrets%s\n' "$C_B" "$C_0"
SESSION_SECRET="$(rand_hex)"
SECRET_KEY="$(rand_hex)"
DB_PASSWORD="$(rand_hex)"
good "session secret, encryption key and database password generated"

# ── write .env, starting from .env.example so the comments stay in sync ─────
[ -f .env.example ] || die ".env.example is missing — the repository looks incomplete."

cp .env.example .env

set_var() { # set_var KEY VALUE
  local key="$1" value="$2"
  # Escape characters that are special to sed's replacement.
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[&/\\]/\\&/g')"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

if [ "$SITE_URL" != "$DEFAULT_URL" ]; then
  set_var COVE_SITE_ADDRESS "$SITE_URL"
fi
set_var COVE_SITE_URL "$SITE_URL"
set_var COVE_HANDLE "$HANDLE"
set_var COVE_SITE_NAME "$SITE_NAME"
set_var COVE_SITE_TAGLINE "$SITE_TAGLINE"
set_var COVE_POWER_PRESET "$POWER"
set_var COVE_SESSION_SECRET "$SESSION_SECRET"
set_var COVE_SECRET_KEY "$SECRET_KEY"
set_var POSTGRES_PASSWORD "$DB_PASSWORD"
set_var COVE_VISIBILITY "$VISIBILITY"
set_var COVE_LIVE_ENABLED "$LIVE"
set_var COVE_FEDERATION_ENABLED "$FED"

# DATABASE_URL embeds the generated password, so it must be rewritten together.
set_var DATABASE_URL "postgres://cove:${DB_PASSWORD}@db:5432/cove"

chmod 600 .env
good "wrote .env (mode 600 — it holds your secrets)"

if [ "$SITE_URL" = "$DEFAULT_URL" ]; then
  printf '\n'
  warn "You chose a localhost URL, so the site will only be reachable from this machine."
  note "That is fine for a trial run. Set COVE_SITE_URL to a real domain before"
  note "turning on federation — federated identities are URLs and must not move."
fi

# ── preflight ───────────────────────────────────────────────────────────────
printf '\n'
./scripts/doctor.sh || true

# ── next steps, tailored to what doctor found ───────────────────────────────
printf '\n%sNext%s\n' "$C_B" "$C_0"

COMPOSE_CMD=""
if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE_CMD="podman compose"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD="podman-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
fi

if [ -z "$COMPOSE_CMD" ]; then
  warn "No compose provider is installed, so the stack cannot start yet."
  note "Fedora:  sudo dnf install podman-compose"
  note "   or:   pipx install podman-compose"
  printf '\n'
  note "Then: $0 && podman compose up -d"
  exit 0
fi

if [ "$LIVE" = "true" ]; then
  say "  ${COMPOSE_CMD} -f compose.yaml -f compose.live.yaml --profile live up -d"
else
  say "  ${COMPOSE_CMD} up -d"
fi
say "  ${COMPOSE_CMD} logs -f web"
printf '\n'
note "Your site will be at: ${SITE_URL}"
