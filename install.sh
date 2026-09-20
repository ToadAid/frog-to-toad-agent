#!/usr/bin/env bash
set -Eeuo pipefail

readonly MIN_NODE_MAJOR=24
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
frog-to-toad-agent installer

Usage:
  ./install.sh          Install locked npm dependencies, then start onboarding
  ./install.sh --check  Check prerequisites without changing anything
  ./install.sh --help   Show this help

Supported release target: Linux with a systemd user manager and Node.js 24+.
The installer never uses sudo and never reads or prints your secrets.
EOF
}

die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command '$1'"
}

check_prerequisites() {
  [[ "$(uname -s)" == "Linux" ]] || die "the public installer currently supports Linux only"
  need_command git
  need_command node
  need_command npm
  need_command bwrap

  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" =~ ^[0-9]+$ ]] || die "could not determine the Node.js major version"
  (( node_major >= MIN_NODE_MAJOR )) || die "Node.js ${MIN_NODE_MAJOR}+ is required (found $(node --version))"

  [[ -f "$SCRIPT_DIR/package.json" ]] || die "package.json is missing from $SCRIPT_DIR"
  [[ -f "$SCRIPT_DIR/package-lock.json" ]] || die "package-lock.json is missing; refusing an unlocked install"
  [[ -f "$SCRIPT_DIR/.env.example" ]] || die ".env.example is missing from the checkout"

  printf 'install: prerequisites OK (Linux, git, Bubblewrap, Node %s, npm %s)\n' \
    "$(node --version)" "$(npm --version)"
}

main() {
  case "${1:-}" in
    --help|-h)
      usage
      return 0
      ;;
    --check)
      check_prerequisites
      return 0
      ;;
    '')
      ;;
    *)
      usage >&2
      die "unknown option '$1'"
      ;;
  esac

  [[ -t 0 && -t 1 ]] || die "onboarding requires an interactive terminal; run ./install.sh directly"
  (( EUID != 0 )) || die "do not install as root; use your normal login account"
  check_prerequisites

  cd -- "$SCRIPT_DIR"
  printf '\ninstall: installing the reviewed dependency lock with npm ci…\n'
  npm ci

  printf '\ninstall: dependencies are ready; starting the resume-safe onboarding wizard…\n'
  printf 'install: secrets are entered only inside onboarding and written to the local .env.\n\n'
  exec npm run onboard
}

main "$@"
