#!/usr/bin/env bash
#
# install.sh — expose the opencode-sandbox CLI globally.
# Symlinks into a PATH bin dir (default ~/.local/bin):
#   opencode-sandboxed   canonical command
#   opencode-sb          short alias
#
#   ./install.sh                 install into ~/.local/bin (default)
#   BIN_DIR=~/bin ./install.sh   or choose the bin dir explicitly
#   ./install.sh --bin ~/bin     same, via flag
#   ./install.sh --uninstall     remove the symlinks
#
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN_DIR="${2:?--bin requires a directory}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT="$ROOT/opencode-sandboxed"
NAMES="opencode-sandboxed opencode-sb"

if [ "$UNINSTALL" = 1 ]; then
  for name in $NAMES; do
    rm -f "$BIN_DIR/$name"
  done
  echo "removed $NAMES from $BIN_DIR"
  exit 0
fi

[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }
[ -f "$ROOT/run.sh" ] || { echo "error: $ROOT/run.sh not found" >&2; exit 1; }
chmod +x "$SCRIPT" "$ROOT/run.sh" 2>/dev/null || true

mkdir -p "$BIN_DIR"
for name in $NAMES; do
  ln -sfn "$SCRIPT" "$BIN_DIR/$name"
  echo "installed: $BIN_DIR/$name -> $SCRIPT"
done

case ":$PATH:" in
  *":$BIN_DIR:"*) echo "ok: $BIN_DIR is on PATH" ;;
  *)
    echo "warning: $BIN_DIR is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if command -v docker >/dev/null 2>&1; then
  echo "ok: docker found"
else
  echo "note: docker not found in PATH — the CLI needs it at runtime"
fi

echo
echo "try:  opencode-sb status"
