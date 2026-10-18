#!/usr/bin/env bash
#
# install.sh — configura uma maquina (zerada ou nao) para o agent-toolbelt.
#
# O que faz:
#   1. memoria  : symlink do CLI em ~/.local/bin (notes) + migra o
#                 banco antigo, se existir, para ~/.local/share/opencode/memory
#   2. skills   : symlink de skills/<id>/SKILL.md para ~/.config/opencode/skills
#   3. tools    : symlink de tools/*.ts para ~/.config/opencode/tools
#   4. plugin   : garante @opencode-ai/plugin resolvivel a partir do repo
#   5. verifica : roda `notes doctor` e checa docker / opencode-sb
#
#   ./install.sh                    instala (default)
#   ./install.sh --check            so diagnostico, nao altera nada
#   ./install.sh --uninstall        remove os symlinks (NUNCA toca nos dados)
#   ./install.sh --prefix DIR       instala tudo sob DIR (teste/portatil):
#                                   DIR/bin, DIR/config/opencode, DIR/data
#
# Variaveis: BIN_DIR, OPENCODE_CONFIG_DIR, XDG_DATA_HOME
#
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
MEM_DIR="$DATA_HOME/opencode/memory"
NEW_DB="$MEM_DIR/notes.db"

MODE=install

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
say()   { printf '%s\n' "$*"; }
warn()  { printf 'aviso: %s\n' "$*" >&2; }
step()  { printf '\n== %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check)     MODE=check; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --prefix)
      [ -n "${2:-}" ] || { echo "--prefix exige um diretorio" >&2; exit 2; }
      BIN_DIR="$2/bin"
      CONFIG_DIR="$2/config/opencode"
      MEM_DIR="$2/data/opencode/memory"
      NEW_DB="$MEM_DIR/notes.db"
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "opcao desconhecida: $1" >&2; usage; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

link() { # link <origem> <destino>; tolera destino em filesystem read-only
  local src="$1" dst="$2"
  if ! mkdir -p "$(dirname "$dst")" 2>/dev/null; then
    warn "sem permissao em $(dirname "$dst") — rode ./install.sh no seu terminal (sem NoNewPrivs)"
    return 1
  fi
  if [ -L "$dst" ]; then
    rm -f "$dst" 2>/dev/null || true
  elif [ -e "$dst" ]; then
    local backup="$dst.bak-$(date +%Y%m%d%H%M%S)"
    if ! mv "$dst" "$backup" 2>/dev/null; then
      warn "nao consegui mover $dst para backup — rode ./install.sh no seu terminal"
      return 1
    fi
    say "  backup: $dst -> $backup"
  fi
  if ! ln -s "$src" "$dst" 2>/dev/null; then
    warn "nao consegui criar $dst — rode ./install.sh no seu terminal (sem NoNewPrivs)"
    return 1
  fi
  say "  link:   $dst -> $src"
}

unlink_ours() { # remove symlink apenas se apontar para dentro do repo
  local dst="$1"
  [ -L "$dst" ] || return 0
  case "$(readlink "$dst")" in
    "$ROOT"/*) rm -f "$dst"; say "  removido: $dst" ;;
  esac
}

# O sistema ja se chamou "notebook"/"nb"; limpa os restos de instalacoes
# anteriores para nao sobrar um binario quebrado no PATH.
cleanup_legacy_bin() {
  local legacy
  for legacy in "$BIN_DIR/notebook" "$BIN_DIR/nb"; do
    [ -e "$legacy" ] || [ -L "$legacy" ] || continue
    case "$(readlink "$legacy" 2>/dev/null || true)" in
      "$ROOT"/*|"$BIN_DIR/notebook")
        rm -f "$legacy" 2>/dev/null && say "  legado: removido $legacy" || true ;;
      *)
        if [ -f "$legacy" ] && grep -q "opencode/memory" "$legacy" 2>/dev/null; then
          mv "$legacy" "$legacy.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null \
            && say "  legado: $legacy -> backup" || true
        fi ;;
    esac
  done
}

cleanup_legacy_skill() {
  local legacy="$CONFIG_DIR/skills/notebook"
  [ -d "$legacy" ] || return 0
  if [ -L "$legacy/SKILL.md" ]; then
    rm -f "$legacy/SKILL.md" 2>/dev/null || true
  elif [ -f "$legacy/SKILL.md" ]; then
    mv "$legacy/SKILL.md" "$legacy/SKILL.md.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  fi
  rmdir "$legacy" 2>/dev/null || true
  say "  legado: skill 'notebook' aposentada (-> 'notes')"
}

check_fts5() {
  python3 - <<'PY' 2>/dev/null
import sqlite3, sys
try:
    c = sqlite3.connect(":memory:")
    c.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
except Exception:
    sys.exit(1)
PY
}

ensure_plugin() {
  if [ -e "$ROOT/node_modules/@opencode-ai/plugin" ]; then
    say "  plugin: ja presente em node_modules/"
    return 0
  fi
  if command -v npm >/dev/null 2>&1 && (cd "$ROOT" && npm install --no-audit --no-fund --silent) >/dev/null 2>&1; then
    say "  plugin: instalado via npm"
    return 0
  fi
  if [ -e "$CONFIG_DIR/node_modules/@opencode-ai/plugin" ]; then
    mkdir -p "$ROOT/node_modules/@opencode-ai"
    ln -sfn "$CONFIG_DIR/node_modules/@opencode-ai/plugin" "$ROOT/node_modules/@opencode-ai/plugin"
    say "  plugin: symlink (sem npm) -> $CONFIG_DIR/node_modules/@opencode-ai/plugin"
    return 0
  fi
  warn "@opencode-ai/plugin indisponivel — as tools podem nao carregar"
}

migrate_db() {
  mkdir -p "$MEM_DIR"
  local legacy
  for legacy in "$CONFIG_DIR/memory/notes.db" "$CONFIG_DIR/memory/bookkeeping.db"; do
    [ -f "$legacy" ] || continue
    if [ -f "$NEW_DB" ]; then
      warn "ja existe $NEW_DB; preservando $legacy como $legacy.orphan"
      mv "$legacy" "$legacy.orphan"
    else
      mv "$legacy" "$NEW_DB"
      say "  banco:  $legacy -> $NEW_DB"
    fi
  done

  # O diretorio antigo guardava o script; agora a fonte e este repo. Preserva
  # (nao apaga) e sai do caminho para nao confundir.
  if [ -d "$CONFIG_DIR/memory" ] && [ -n "$(ls -A "$CONFIG_DIR/memory" 2>/dev/null || true)" ]; then
    local archive="$MEM_DIR/legacy-config-memory"
    rm -rf "$archive"
    mv "$CONFIG_DIR/memory" "$archive"
    say "  legado: $CONFIG_DIR/memory -> $archive"
  elif [ -d "$CONFIG_DIR/memory" ]; then
    rmdir "$CONFIG_DIR/memory" 2>/dev/null || true
  fi
  [ -f "$NEW_DB" ] || say "  banco:  sera criado sob demanda em $NEW_DB"
}

check_sandbox() {
  if command -v opencode-sb >/dev/null 2>&1 || [ -x "$BIN_DIR/opencode-sb" ]; then
    say "  sandbox: CLI 'opencode-sb' encontrado"
  elif [ -x "$ROOT/sandbox/install.sh" ]; then
    warn "opencode-sb ausente — rode: $ROOT/sandbox/install.sh"
  else
    warn "opencode-sb ausente — as tools de sandbox nao vao funcionar"
  fi
}

permissions_hint() {
  cat <<EOF

  Permissoes (adicione ao seu opencode config se ainda nao tiver):
    "permissions": [
      { "action": "skill", "resource": "*",        "effect": "deny"  },
      { "action": "skill", "resource": "notes", "effect": "allow" },
      { "action": "skill", "resource": "sandbox",  "effect": "allow" }
    ]
EOF
}

# --------------------------------------------------------------------------- #
# modos
# --------------------------------------------------------------------------- #

cmd_check() {
  say "agent-toolbelt — preflight"
  say "repo: $ROOT"

  step "dependencias"
  if command -v python3 >/dev/null 2>&1; then
    local py; py="$(python3 -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])')"
    if check_fts5; then
      say "  python3 : $py  (fts5: sim)"
    else
      say "  python3 : $py  (fts5: NAO — a busca vai degradar para LIKE)"
    fi
  else
    warn "python3 ausente — o subsistema de memoria nao funciona"
  fi
  command -v docker >/dev/null 2>&1 \
    && say "  docker  : $(docker --version 2>/dev/null | head -n1)" \
    || warn "docker ausente — as tools de sandbox nao funcionam"
  command -v opencode >/dev/null 2>&1 \
    && say "  opencode: $(command -v opencode)" \
    || say "  opencode: nao esta no PATH deste shell (ok se voce o lanca de outro)"

  step "componentes"
  for f in "$BIN_DIR/notes"; do
    [ -e "$f" ] && say "  bin     : $f" || say "  bin     : (ausente) $f"
  done
  for f in "$CONFIG_DIR/skills/notes/SKILL.md" "$CONFIG_DIR/skills/sandbox/SKILL.md"; do
    [ -e "$f" ] && say "  skill   : $f" || say "  skill   : (ausente) $f"
  done
  for f in "$CONFIG_DIR/tools/notes.ts" "$CONFIG_DIR/tools/sandbox.ts"; do
    [ -e "$f" ] && say "  tool    : $f" || say "  tool    : (ausente) $f"
  done
  say "  banco   : $NEW_DB"
  check_sandbox
  exit 0
}

cmd_uninstall() {
  say "agent-toolbelt — desinstalando symlinks (dados preservados)"
  unlink_ours "$BIN_DIR/notes"
  for d in "$ROOT"/skills/*/; do
    [ -d "$d" ] || continue
    unlink_ours "$CONFIG_DIR/skills/$(basename "$d")/SKILL.md"
  done
  for t in "$ROOT"/tools/*.ts; do
    [ -e "$t" ] || continue
    unlink_ours "$CONFIG_DIR/tools/$(basename "$t")"
  done
  say ""
  say "banco preservado em: $NEW_DB"
  exit 0
}

cmd_install() {
  say "agent-toolbelt — instalando"
  say "repo:   $ROOT"
  say "bin:    $BIN_DIR"
  say "config: $CONFIG_DIR"

  step "1/5 plugin (@opencode-ai/plugin)"
  ensure_plugin

  step "2/5 memoria"
  chmod +x "$ROOT/memory/notes" "$ROOT/memory/notes.py" 2>/dev/null || true
  link "$ROOT/memory/notes" "$BIN_DIR/notes" || true
  cleanup_legacy_bin
  migrate_db

  step "3/5 skills"
  local name
  cleanup_legacy_skill
  for d in "$ROOT"/skills/*/; do
    [ -f "$d/SKILL.md" ] || continue
    name="$(basename "${d%/}")"
    link "${d%/}/SKILL.md" "$CONFIG_DIR/skills/$name/SKILL.md" || true
  done

  step "4/5 tools"
  mkdir -p "$CONFIG_DIR/tools" 2>/dev/null || true
  for t in "$ROOT"/tools/*.ts; do
    [ -f "$t" ] || continue
    link "$t" "$CONFIG_DIR/tools/$(basename "$t")" || true
  done

  step "5/5 verificacao"
  # Verifica pelo wrapper do proprio repo: independe dos symlinks em BIN_DIR.
  NOTES_DB="$NEW_DB" "$ROOT/memory/notes" init
  NOTES_DB="$NEW_DB" "$ROOT/memory/notes" doctor || warn "doctor reportou problemas (ver acima)"
  if [ -e "$BIN_DIR/notes" ]; then
    say "  bin:    ok ($BIN_DIR/notes)"
  else
    warn "$BIN_DIR/notes ausente — rode ./install.sh no seu terminal para criar o symlink"
  fi
  check_sandbox
  case ":$PATH:" in
    *":$BIN_DIR:"*) say "  PATH   : ok ($BIN_DIR)" ;;
    *) warn "$BIN_DIR nao esta no PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac

  permissions_hint
  say ""
  say "pronto."
  if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
    say "Obs.: se a instalacao rodou de um shell com NoNewPrivs/read-only em"
    say "      ~/.local/bin, reexecute ./install.sh no seu terminal normal."
  fi
}

case "$MODE" in
  check)     cmd_check ;;
  uninstall) cmd_uninstall ;;
  install)   cmd_install ;;
esac
