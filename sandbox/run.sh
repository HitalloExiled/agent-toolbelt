#!/usr/bin/env bash
#
# run.sh — orchestrate sandboxed OpenCode tasks in hardened, ephemeral containers.
#
#   ./run.sh task  --prompt "..." [options]   run one sandboxed task
#   ./run.sh watch [<run-id>]                  follow a run's full live transcript
#   ./run.sh peek  [<run-id>] [-n N]           bounded snapshot: last N messages
#   ./run.sh watch --session [--from-start]    follow the active session live
#   ./run.sh peek  --session [-n N] [<sid>]    bounded snapshot of the session
#   ./run.sh sessions                          list the session's sessions
#   ./run.sh up                                start a long-lived session container
#   ./run.sh down                              stop and remove the session container
#   ./run.sh logs  <run-id>                    show the egress proxy log of a run
#   ./run.sh models [--check]                  list the sandbox model catalog
#   ./run.sh clean                             remove orphaned sandbox/proxy containers
#
# Artifacts: runs/<run-id>/ (result.json, stderr.log, proxy.log, exit)
# Host output: SANDBOX_OUT_ROOT/<run-id>/ (default ~/.sandbox), mounted rw at
#              /workspace/out — a fixed prefix, never chosen by the caller.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS_DIR="$ROOT/runs"
MODELS_CACHE="$RUNS_DIR/.models"

# Model catalog preferences (ordered; first available wins). Defined in
# models.conf so they can be edited without touching this script.
# shellcheck source=models.conf
if [ -f "$ROOT/models.conf" ]; then . "$ROOT/models.conf"; fi
FREE_PREFERRED="${FREE_PREFERRED:-opencode/deepseek-v4.1-flash-free}"
FREE_PATTERN="${FREE_PATTERN:-^opencode/.*-free$}"
LOCAL_LARGE="${LOCAL_LARGE:-llama.cpp/qwen3.8-gguf-single192}"
LOCAL_PARALLEL="${LOCAL_PARALLEL:-llama.cpp/qwen3.8-gguf-duo128}"

NETWORK="opencode-sandbox-net"
EGRESS_NETWORK="opencode-sandbox-egress"
SEALED_NETWORK="opencode-sandbox-sealed"
WORKER_IMAGE="opencode-sandbox:latest"
PROXY_IMAGE="opencode-sandbox-proxy:latest"
SESSION="opencode-sandbox-session"
SESSION_PROXY="opencode-sandbox-proxy-session"
SESSION_CONFIG="/home/sandbox/.config/opencode/opencode.jsonc"
PROXY_PORT=8888

# Host-side OpenCode config used as the base for the sandbox config. The model
# backend (127.0.0.1:BACKEND_PORT) is rewritten to host.docker.internal:RELAY.
HOST_CONFIG="${OPENCODE_HOST_CONFIG:-$HOME/.config/opencode/opencode.jsonc}"
BACKEND_PORT=18089
RELAY_PORT=18090
NO_PROXY_LIST="model-relay,host.docker.internal,127.0.0.1,localhost"

CPUS="${CPUS:-4}"
MEM="${MEM:-8g}"
TIMEOUT="${TIMEOUT:-1800}"

# The worker's writable areas are RAM-backed tmpfs, which Docker does NOT charge
# to --memory. Size them so a runaway download/build/extraction cannot eat the
# host's RAM; they are the only knobs a caller normally needs to raise.
TMP_SIZE="${SANDBOX_TMP_SIZE:-4g}"
WORKSPACE_SIZE="${SANDBOX_WORKSPACE_SIZE:-16g}"
HOME_TMPFS_SIZE="${SANDBOX_HOME_TMPFS_SIZE:-1g}"

log() { printf '[opencode-sandbox] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  ./run.sh task --prompt "..." [options]     run one sandboxed task
  ./run.sh watch [<run-id>]                  follow a run's full live transcript
  ./run.sh peek  [<run-id>] [-n N]           bounded snapshot: last N messages (default 12)
  ./run.sh watch --session [--from-start]    follow the active session live
  ./run.sh peek  --session [-n N] [<sid>]    bounded snapshot of the active session
  ./run.sh sessions                          list the running session's sessions
  ./run.sh up                                start a long-lived session container
  ./run.sh down                              stop and remove the session container
  ./run.sh logs <run-id>                     show the egress proxy log of a run
  ./run.sh models [--check]                  list the sandbox model catalog (--check validates)
  ./run.sh clean                             remove orphaned sandbox/proxy containers

task options:
  --prompt TEXT         task prompt for the sandboxed agent
  --prompt-file FILE|-  read the prompt from a file ('-' = stdin)
  --copy-in PATH        copy a host file/dir into /workspace (repeatable)
  --model REF           model ref (default: free online, local for --sealed)
  --title TEXT          session title
  --cpus N              CPU limit (default 4)
  --mem SIZE            memory limit (default 8g)
  --timeout SECS        hard timeout (default 1800)
  --sealed              no internet at all (internal-only network)
  --follow/--no-follow  relay the agent's live transcript (default: on a TTY)
  --detach, -d          return immediately; follow later with `watch <run-id>`
  --strict              fail if --model is not in the sandbox catalog
  --rebuild             rebuild the worker/proxy images before running

Environment: CPUS, MEM, TIMEOUT, OPENCODE_HOST_CONFIG, REBUILD, SANDBOX_OUT_ROOT
  Sandbox output lands in SANDBOX_OUT_ROOT/<run-id>/ (default ~/.sandbox),
  bind-mounted rw at /workspace/out. The prefix is fixed by the human only.
  Model preferences live in models.conf (ordered; first available wins).
  DOCKER_HOST must point at the machine daemon (from a sandboxed shell:
  export DOCKER_HOST=unix:///var/run/docker.sock).
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { log "error: docker not found"; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    log "error: cannot reach the docker daemon (permissions?)"
    exit 1
  fi
}

build_image() { # $1 = tag, $2 = context dir
  if [ "${REBUILD:-0}" = 1 ] && docker image inspect "$1" >/dev/null 2>&1; then
    log "removing $1 (--rebuild)"
    docker rmi -f "$1" >/dev/null 2>&1 || true
  fi
  if docker image inspect "$1" >/dev/null 2>&1; then
    return 0
  fi
  log "building $1 (first run, may take a minute)..."
  local out
  if ! out="$(docker build -t "$1" "$2" 2>&1)"; then
    # In environments where ~/.docker is read-only, buildx cannot store its
    # client state; the legacy builder keeps all state on the daemon side.
    log "buildx build failed; retrying with legacy builder (DOCKER_BUILDKIT=0)"
    DOCKER_BUILDKIT=0 docker build -t "$1" "$2"
  fi
}

build_images() {
  build_image "$WORKER_IMAGE" "$ROOT"
  build_image "$PROXY_IMAGE" "$ROOT/proxy"
}

ensure_network() { # $1 = name, $2 = "internal"
  local name="$1" internal="${2:-}"
  if docker network inspect "$name" >/dev/null 2>&1; then
    if [ "$internal" = "internal" ] \
      && [ "$(docker network inspect "$name" --format '{{.Internal}}')" != "true" ]; then
      # Upgrade path: an existing non-internal sandbox network would leak
      # direct egress, defeating the proxy.
      log "recreating network $name as internal (enforced egress)"
      docker network rm "$name" >/dev/null 2>&1 \
        || { log "error: cannot recreate $name (containers still attached)"; exit 1; }
      # The relay is bound to the old gateway IP; force a fresh one.
      docker rm -f "model-relay-$name" >/dev/null 2>&1 || true
    else
      return 0
    fi
  fi
  if [ "$internal" = "internal" ]; then
    docker network create --internal "$name" >/dev/null
  else
    docker network create "$name" >/dev/null
  fi
}

network_subnet() {
  docker network inspect "$1" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
}

network_gateway() {
  docker network inspect "$1" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
}

# The model backend listens on host localhost only, which bridge containers
# cannot reach. This starts (once per network) a minimal TCP relay bound ONLY
# to that bridge's own gateway IP (the containers' default route, reachable
# solely from that bridge):
#   <gateway>:RELAY_PORT -> 127.0.0.1:BACKEND_PORT
# Sandbox containers address it as `model-relay` (see worker_create_flags).
# The relay is stdlib-only python (relay/forward.py), read-only, cap-dropped.
ensure_relay() { # $1 = network
  local name="model-relay-$1"
  local gw
  gw="$(network_gateway "$1")"
  if [ -z "$gw" ]; then
    log "error: no gateway found for network $1"
    exit 1
  fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    # Restart if it is bound to a stale gateway (e.g. after network recreation).
    if docker inspect "$name" --format '{{range .Args}}{{.}} {{end}}' \
      | grep -q " $gw "; then
      return 0
    fi
    log "relay $name is bound to a stale gateway; recreating"
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    --network host \
    --read-only --tmpfs /tmp:rw,noexec,size=16m \
    --cap-drop=ALL --security-opt no-new-privileges \
    -v "$ROOT/relay/forward.py:/relay/forward.py:ro" \
    --entrypoint python3 \
    "$WORKER_IMAGE" /relay/forward.py "$gw" "$RELAY_PORT" 127.0.0.1 "$BACKEND_PORT" >/dev/null
  sleep 1
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    log "error: model relay failed to start; logs:"
    docker logs "$name" 2>&1 | tail -5 >&2 || true
    exit 1
  fi
  log "model relay up: $gw:$RELAY_PORT -> 127.0.0.1:$BACKEND_PORT"
}

write_proxy_conf() { # $1 = out file, $2 = allowed subnet
  sed "s|{{SUBNET}}|$2|" "$ROOT/proxy/tinyproxy.conf.in" > "$1"
}

start_proxy() { # $1 = name, $2 = sandbox (internal) network, $3 = conf file
  docker rm -f "$1" >/dev/null 2>&1 || true
  # Dual-homed: egress side (first network = default route) carries the
  # internet, internal side is how sandbox containers reach the proxy. This
  # makes the proxy the only egress path, so logging is enforced, not advisory.
  ensure_network "$EGRESS_NETWORK"
  # --user tinyproxy: this process parses untrusted proxy traffic, so it must
  # not be root. tinyproxy cannot drop privileges itself here (CAP_SETUID is
  # dropped), so Docker does the drop; the /var/log tmpfs is world-writable
  # (sticky) so the log file stays writable whatever uid the image uses.
  docker run -d --name "$1" \
    --network "$EGRESS_NETWORK" \
    --read-only \
    --tmpfs /tmp:rw,noexec,size="${PROXY_TMP_SIZE:-16m}" \
    --tmpfs /run:rw,noexec,mode=1777,size="${PROXY_RUN_SIZE:-4m}" \
    --tmpfs /var/log:rw,mode=1777,size="${PROXY_LOG_SIZE:-32m}" \
    --cap-drop=ALL --security-opt no-new-privileges \
    --user tinyproxy \
    -v "$3:/etc/tinyproxy/tinyproxy.conf:ro" \
    "$PROXY_IMAGE" >/dev/null
  docker network connect "$2" "$1"
  local i
  for i in 1 2 3 4 5 6 7 8; do
    if docker exec "$1" pgrep -x tinyproxy >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  log "warning: proxy $1 did not confirm it is up; continuing anyway"
}

generate_config() { # $1 = out dir
  if [ ! -f "$HOST_CONFIG" ]; then
    log "error: host OpenCode config not found at $HOST_CONFIG"
    log "  (override with OPENCODE_HOST_CONFIG=...)"
    exit 1
  fi
  # The sandbox talks to the model relay instead of the host's loopback providers.
  sed "s|127\\.0\\.0\\.1:${BACKEND_PORT}|model-relay:${RELAY_PORT}|g" \
    "$HOST_CONFIG" > "$1/opencode.jsonc"

  # The host config denies every skill except an allowlist. The sandbox ships
  # its own skills (webpage, ps4) and no host skills are copied in, so open the
  # skill permission up for the sandbox copy. Rewriting as plain JSON is fine:
  # this file is generated, not hand-edited.
  python3 - "$1/opencode.jsonc" <<'PY' || true
import json, re, sys
p = sys.argv[1]
src = open(p).read()
out, i, n = [], 0, len(src)
while i < n:
    c = src[i]
    if c == '"':                       # copy strings verbatim
        j = i + 1
        while j < n:
            if src[j] == "\\":
                j += 2
                continue
            if src[j] == '"':
                break
            j += 1
        out.append(src[i:j + 1])
        i = j + 1
    elif src.startswith("//", i):       # line comment
        j = src.find("\n", i)
        i = n if j < 0 else j
    elif src.startswith("/*", i):       # block comment
        j = src.find("*/", i)
        i = n if j < 0 else j + 2
    else:
        out.append(c)
        i += 1
text = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
cfg = json.loads(text)
for rule in cfg.get("permissions") or []:
    if isinstance(rule, dict) and rule.get("action") == "skill":
        rule["effect"] = "allow"
open(p, "w").write(json.dumps(cfg, indent=2) + "\n")
PY
}

# File transfer uses `docker exec` stdio streaming, never `docker cp`:
# on this daemon `docker cp` cannot see mount (tmpfs) content, while the
# exec channel works. Both images ship sh/tar/cat (fedora base).
stream_file_into() { # $1 = container, $2 = local src file, $3 = container dest path
  # mkdir -p: tmpfs mounts shadow any image-baked directories beneath them.
  docker exec -i "$1" sh -c 'mkdir -p "$(dirname "$0")" && cat > "$0"' "$3" < "$2"
}

stream_dir_into() { # $1 = container, $2 = local src dir, $3 = container dest dir
  docker exec "$1" mkdir -p "$3" >/dev/null
  tar -C "$2" -cf - . | docker exec -i "$1" tar -C "$3" -xf -
}

stream_file_out() { # $1 = container, $2 = container src file, $3 = local dest file
  docker exec "$1" cat "$2" > "$3"
}

stream_dir_out() { # $1 = container, $2 = container src dir, $3 = local dest parent dir
  local base parent
  base="$(basename "$2")"
  parent="$(dirname "$2")"
  mkdir -p "$3"
  docker exec "$1" tar -C "$parent" -cf - "$base" | tar -C "$3" -xf -
}

container_has() { # $1 = container, $2 = path  (file or dir)
  docker exec "$1" test -e "$2" >/dev/null 2>&1
}

# Print the model catalog as the sandbox sees it: an ephemeral container from
# the worker image with the generated (relay-rewritten) config seeded, exactly
# like a real run. No network is needed — the provider list comes from the
# seeded config and `opencode/*` is bundled in the binary. Cached per image id
# so repeated calls are free until the image changes.
worker_models() {
  local img id cache
  img="$(docker image inspect "$WORKER_IMAGE" --format '{{.Id}}' 2>/dev/null)" || img=""
  id="${img#sha256:}"; id="${id:0:12}"
  cache="$MODELS_CACHE/$id.txt"
  if [ -n "$id" ] && [ -s "$cache" ]; then
    cat "$cache"; return 0
  fi

  local cfgdir="$RUNS_DIR/_models/config"
  mkdir -p "$cfgdir"
  generate_config "$cfgdir"

  local cname="models-$$-$RANDOM" out
  docker rm -f "$cname" >/dev/null 2>&1 || true
  # Same isolation as a task container, minus the network: this only lists the
  # model catalog, but it still runs the image's CLI against the host config.
  docker create --name "$cname" --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,size=64m \
    --tmpfs /home/sandbox/.config:rw,uid=1000,gid=1000,size=16m \
    --tmpfs /home/sandbox/.cache:rw,uid=1000,gid=1000,size=128m \
    --tmpfs /home/sandbox/.local:rw,uid=1000,gid=1000,size=128m \
    --cap-drop=ALL --security-opt no-new-privileges --pids-limit=128 \
    --entrypoint sleep \
    "$WORKER_IMAGE" infinity >/dev/null
  docker start "$cname" >/dev/null
  stream_file_into "$cname" "$cfgdir/opencode.jsonc" \
    /home/sandbox/.config/opencode/opencode.jsonc
  out="$(docker exec "$cname" opencode models 2>/dev/null)" || true
  docker rm -f "$cname" >/dev/null 2>&1 || true

  # Keep only provider/model lines (drop banners/blank output).
  out="$(printf '%s\n' "$out" | grep -E '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || true)"
  if [ -n "$id" ] && [ -n "$out" ]; then
    mkdir -p "$MODELS_CACHE"
    printf '%s\n' "$out" > "$cache"
  fi
  printf '%s\n' "$out"
}

# resolve_model "<preferred refs>" [fallback-pattern]
# Prints the first preferred ref present in the sandbox catalog; if none and a
# pattern is given, the first catalog entry matching it. Returns 1 if nothing
# resolves (so callers can fall through / fail clearly).
resolve_model() {
  local preferred="$1" pattern="${2:-}" catalog ref
  catalog="$(worker_models)"
  if [ -z "$catalog" ]; then
    log "error: empty model catalog (is $WORKER_IMAGE built?)"
    return 1
  fi
  for ref in $preferred; do
    if printf '%s\n' "$catalog" | grep -qxF "$ref"; then printf '%s' "$ref"; return 0; fi
  done
  if [ -n "$pattern" ]; then
    ref="$(printf '%s\n' "$catalog" | grep -E "$pattern" | head -n1)"
    if [ -n "$ref" ]; then printf '%s' "$ref"; return 0; fi
  fi
  return 1
}

cmd_models() {
  local check=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --check)   check=1; shift ;;
      --rebuild) REBUILD=1; shift ;;
      *) log "unknown option for 'models': $1"; usage; exit 2 ;;
    esac
  done
  require_docker
  build_images

  local catalog
  catalog="$(worker_models)"
  if [ -z "$catalog" ]; then
    log "error: could not read the model catalog from $WORKER_IMAGE"
    exit 1
  fi
  printf '%s\n' "$catalog"
  [ "$check" = 1 ] || return 0

  local rc=0 entry name rest preferred pattern ref first provider alt
  for entry in \
    "free|$FREE_PREFERRED|$FREE_PATTERN" \
    "local-large|$LOCAL_LARGE|" \
    "local-parallel|$LOCAL_PARALLEL|"; do
    name="${entry%%|*}"; rest="${entry#*|}"
    preferred="${rest%%|*}"; pattern="${rest#*|}"
    first="${preferred%% *}"
    if ref="$(resolve_model "$preferred" "$pattern")"; then
      if [ "$ref" = "$first" ]; then
        log "OK      $name -> $ref"
      else
        log "OK*     $name -> $ref  (preferred '$first' missing; auto-resolved)"
      fi
    else
      rc=1
      provider="${first%%/*}"
      alt="$(printf '%s\n' "$catalog" | grep -E "^${provider}/" | head -n8 | tr '\n' ' ')"
      log "MISSING $name  (preferred: $preferred)"
      log "        available ${provider}/*: ${alt:-none}"
    fi
  done
  if [ "$rc" != 0 ]; then
    log "check FAILED: a preferred model is no longer in the catalog (update models.conf)"
  else
    log "check OK: every preferred model is available"
  fi
  return "$rc"
}

worker_create_flags() { # $1 = network
  local -a f=(
    --network "$1"
    --add-host host.docker.internal:host-gateway
    --add-host "model-relay:$(network_gateway "$1")"
    --read-only
    # exec is required in the writable areas: bun/OpenTUI dlopens a native
    # render library from /tmp, and build outputs in /workspace must be
    # runnable. Docker's tmpfs default is noexec, which breaks both with
    # "failed to map segment from shared object". Inside the container the
    # sandbox boundary is the security control, so noexec buys nothing here.
    # size= matters: tmpfs pages are host RAM and are not counted by --memory.
    --tmpfs "/tmp:rw,exec,mode=1777,size=$TMP_SIZE"
    --tmpfs "/workspace:rw,exec,uid=1000,gid=1000,size=$WORKSPACE_SIZE"
    --tmpfs "/home/sandbox/.local:rw,exec,uid=1000,gid=1000,size=$HOME_TMPFS_SIZE"
    --tmpfs "/home/sandbox/.cache:rw,exec,uid=1000,gid=1000,size=$HOME_TMPFS_SIZE"
    --tmpfs "/home/sandbox/.config:rw,exec,uid=1000,gid=1000,size=$HOME_TMPFS_SIZE"
    --tmpfs "/home/sandbox/.npm:rw,exec,uid=1000,gid=1000,size=$HOME_TMPFS_SIZE"
    --tmpfs "/home/sandbox/.bun:rw,exec,uid=1000,gid=1000,size=$HOME_TMPFS_SIZE"
    --cap-drop=ALL --security-opt no-new-privileges
    --pids-limit=256
    --shm-size=512m
    --cpus "$CPUS" --memory "$MEM"
  )
  printf '%s\n' "${f[@]}"
}

worker_env() { # $1 = proxy name (empty for sealed)
  local -a env=(
    -e HOME=/home/sandbox
    -e NO_PROXY="$NO_PROXY_LIST" -e no_proxy="$NO_PROXY_LIST"
  )
  if [ -n "$1" ]; then
    env+=(
      -e HTTP_PROXY="http://$1:$PROXY_PORT" -e HTTPS_PROXY="http://$1:$PROXY_PORT"
      -e http_proxy="http://$1:$PROXY_PORT" -e https_proxy="http://$1:$PROXY_PORT"
    )
  fi
  printf '%s\n' "${env[@]}"
}

# OpenCode keeps the websearch provider choice in its SQLite kv, not in the
# config: the desktop app writes `websearch:provider` on the host, so a fresh
# sandbox DB has no such row and every search fails with "Web search
# cancelled". Mirror the host's choice (falling back to "random", OpenCode's
# own default). It is state, so it must be written after the DB exists.
websearch_provider() {
  local v="${SANDBOX_WEBSEARCH_PROVIDER:-}"
  if [ -z "$v" ]; then
    v="$(python3 - "$HOME/.local/share/opencode/opencode.db" <<'PY' 2>/dev/null || true
import json, os, sqlite3, sys
p = sys.argv[1]
if os.path.exists(p):
    try:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        row = c.execute("select value from kv where key='websearch:provider'").fetchone()
        if row:
            print(json.loads(row[0]))
    except Exception:
        pass
PY
)"
  fi
  printf '%s' "${v:-random}"
}

seed_state() { # $1 = container name
  local c="$1" provider
  provider="$(websearch_provider)"
  # Let OpenCode create/migrate its DB, then set the row (idempotent, ~0.3s).
  docker exec "$c" opencode api --standalone GET /api/config >/dev/null 2>&1 || true
  docker exec -i "$c" python3 - "$provider" >/dev/null 2>&1 <<'PY' || true
import json, os, sqlite3, sys, time
p = os.path.expanduser("~/.local/share/opencode/opencode.db")
if not os.path.exists(p):
    raise SystemExit(0)
c = sqlite3.connect(p)
now = int(time.time() * 1000)
c.execute(
    "insert into kv(key, value, time_created, time_updated) values(?, ?, ?, ?) "
    "on conflict(key) do update set value=excluded.value, time_updated=excluded.time_updated",
    ("websearch:provider", json.dumps(sys.argv[1]), now, now))
c.commit()
PY
}

# The sandbox agent only knows what it can discover, so seed the skills that
# document the image's own tools (webpage, ps4) into its config dir.
seed_skills() { # $1 = container name
  local c="$1" dir name
  for dir in "$ROOT"/skills/*/; do
    [ -f "$dir/SKILL.md" ] || continue
    name="$(basename "$dir")"
    stream_file_into "$c" "$dir/SKILL.md" \
      "/home/sandbox/.config/opencode/skills/$name/SKILL.md"
  done
}

# Resolve the FIXED host output root. The sandbox always writes its
# /workspace/out here, under <run-id>/ (tasks) or session/ (interactive). This
# is NOT the caller's choice: only the human sets the root, via the environment
# (SANDBOX_OUT_ROOT, default ~/.sandbox). A fallback keeps runs working where
# the preferred root cannot be created (e.g. the OpenCode agent shell, where
# $HOME's own root is read-only); dangerous roots are refused.
#
# The mounted dir is a real rw host mount: the untrusted sandbox can
# write/overwrite/delete anything under it, with no quota — which is why the
# path is fixed and never taken from the task caller.
prepare_out_root() {
  local root="${SANDBOX_OUT_ROOT:-$HOME/.sandbox}"
  if ! mkdir -p "$root" 2>/dev/null; then
    log "warning: cannot create SANDBOX_OUT_ROOT='$root' (read-only here?)"
    root="$RUNS_DIR/host"
    log "         falling back to $root — set SANDBOX_OUT_ROOT to choose the prefix"
    mkdir -p "$root" || { log "error: cannot create fallback root '$root'"; exit 2; }
  fi
  root="$(cd "$root" && pwd -P)" || { log "error: cannot resolve output root"; exit 2; }
  case "$root" in
    /|/home|/etc|/usr|/var|/boot|/root|/proc|/sys|/dev|/run|/bin|/sbin|/lib|/lib64|"$HOME")
      log "error: refusing SANDBOX_OUT_ROOT='$root' (pick a dedicated subdir)"
      exit 2 ;;
  esac
  [ -w "$root" ] || { log "error: output root '$root' is not writable"; exit 2; }
  printf '%s' "$root"
}

session_running() { # a running session container (docker ps lists running only)
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SESSION"
}

session_exists() { # a session container in any state
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SESSION"
}

cmd_task() {
  local -a orig_args=("$@")
  local prompt="" prompt_file="" model="" title="" sealed=0 src strict="${STRICT:-0}"
  local detach=0
  local copy_in=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt)      prompt="${2:?}"; shift 2 ;;
      --prompt-file) prompt_file="${2:?}"; shift 2 ;;
      --copy-in)     copy_in+=("${2:?}"); shift 2 ;;
      --model)       model="${2:?}"; shift 2 ;;
      --title)       title="${2:?}"; shift 2 ;;
      --cpus)        CPUS="${2:?}"; shift 2 ;;
      --mem)         MEM="${2:?}"; shift 2 ;;
      --timeout)     TIMEOUT="${2:?}"; shift 2 ;;
      --sealed)      sealed=1; shift ;;
      --strict)      strict=1; shift ;;
      --follow)      SANDBOX_FOLLOW=1; shift ;;
      --no-follow)   SANDBOX_FOLLOW=0; shift ;;
      --detach|-d)   detach=1; shift ;;
      --rebuild)     REBUILD=1; shift ;;
      *) log "unknown option for 'task': $1"; usage; exit 2 ;;
    esac
  done

  if [ -n "$prompt_file" ]; then
    if [ "$prompt_file" = "-" ]; then prompt="$(cat)"; else prompt="$(cat "$prompt_file")"; fi
  fi
  if [ -z "$prompt" ]; then
    log "error: no prompt given (use --prompt or --prompt-file)"
    usage
    exit 2
  fi

  # Detached: hand off to a background copy of ourselves with a pre-seeded run
  # id, so the caller gets the id immediately and can follow with `watch`. The
  # child re-runs the same args but sees SANDBOX_RUNID set, so it skips this.
  if [ "$detach" = 1 ] && [ -z "${SANDBOX_RUNID:-}" ]; then
    local runid="run-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
    mkdir -p "$RUNS_DIR/$runid"
    SANDBOX_RUNID="$runid" SANDBOX_FOLLOW=0 SANDBOX_DETACHED=1 \
      setsid nohup "$ROOT/run.sh" task "${orig_args[@]}" \
      > "$RUNS_DIR/$runid/bootstrap.log" 2>&1 &
    printf 'run %s\n' "$runid"
    log "detached: $runid (bootstrap log: runs/$runid/bootstrap.log)"
    log "  follow : opencode-sb watch $runid"
    exit 0
  fi

  require_docker
  build_images

  # Resolve the model. Explicit --model wins (warned, or fatal with --strict,
  # when unknown); otherwise a mode-aware default: free for online runs, a
  # local large-context model for --sealed (free models need egress).
  if [ -n "$model" ]; then
    if ! worker_models | grep -qxF "$model"; then
      log "warning: model '$model' is not in the sandbox catalog (run: opencode-sb models)"
      if [ "$strict" = 1 ]; then
        log "error: --strict set and model '$model' is unavailable"
        exit 2
      fi
    fi
  elif [ "$sealed" = 1 ]; then
    model="$(resolve_model "$LOCAL_LARGE")" || model=""
    if [ -z "$model" ]; then
      log "error: no local model available for --sealed (run: opencode-sb models)"
      exit 2
    fi
    log "model: $model (local; --sealed has no egress)"
  else
    model="$(resolve_model "$FREE_PREFERRED" "$FREE_PATTERN")" || model=""
    if [ -n "$model" ]; then
      log "model: $model (free)"
    else
      model="$(resolve_model "$LOCAL_LARGE")" || model=""
      if [ -z "$model" ]; then
        log "error: no model available (run: opencode-sb models)"
        exit 2
      fi
      log "model: $model (local; no free model available)"
    fi
  fi

  local runid="${SANDBOX_RUNID:-run-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
  local sandbox="sandbox-$runid"
  local net="$NETWORK" proxy_name="" conf=""
  local run_dir="$RUNS_DIR/$runid"
  mkdir -p "$run_dir/config"

  # Fixed host output prefix (never caller-chosen).
  local out_root out_dir
  out_root="$(prepare_out_root)"
  out_dir="$out_root/$runid"
  mkdir -p "$out_dir"
  log "run: $runid (follow: opencode-sb watch $runid)"

  cleanup_task() {
    # :- guards: the EXIT trap may fire after function locals are gone.
    docker rm -f "${sandbox:-__none__}" >/dev/null 2>&1 || true
    if [ -n "${proxy_name:-}" ]; then docker rm -f "$proxy_name" >/dev/null 2>&1 || true; fi
  }
  trap cleanup_task EXIT INT TERM

  if [ "$sealed" = 1 ]; then
    net="$SEALED_NETWORK"
    ensure_network "$net" internal
  else
    net="$NETWORK"
    ensure_network "$net" internal
    proxy_name="proxy-$runid"
    conf="$run_dir/proxy.conf"
    write_proxy_conf "$conf" "$(network_subnet "$net")"
    start_proxy "$proxy_name" "$net" "$conf"
  fi
  ensure_relay "$net"
  generate_config "$run_dir/config"

  docker rm -f "$sandbox" >/dev/null 2>&1 || true

  local create_flags env
  create_flags="$(worker_create_flags "$net")"
  env="$(worker_env "$proxy_name")"

  # /workspace/out is bind-mounted to the fixed host prefix, so the sandbox's
  # deliverables land on the host directly (nothing is collected into
  # runs/<id>/out).
  local -a mount_flags=(-v "$out_dir:/workspace/out:rw")

  # NOTE: --entrypoint overrides the image ENTRYPOINT (opencode); without it
  # `sleep infinity` would run as `opencode sleep infinity`. The container
  # must be started before exec-based seeding works.
  # shellcheck disable=SC2086
  docker create --name "$sandbox" \
    $create_flags \
    $env \
    "${mount_flags[@]}" \
    --entrypoint sleep \
    -w /workspace \
    "$WORKER_IMAGE" infinity >/dev/null
  docker start "$sandbox" >/dev/null
  stream_file_into "$sandbox" "$run_dir/config/opencode.jsonc" \
    /home/sandbox/.config/opencode/opencode.jsonc
  seed_state "$sandbox"
  seed_skills "$sandbox"

  for src in "${copy_in[@]}"; do
    if [ ! -e "$src" ]; then
      log "error: --copy-in path not found: $src"
      exit 2
    fi
    if [ -d "$src" ]; then
      stream_dir_into "$sandbox" "$src" "/workspace/$(basename "$src")"
    else
      stream_file_into "$sandbox" "$src" "/workspace/$(basename "$src")"
    fi
  done

  local run_args=(run --standalone --auto --format json)
  if [ -n "$model" ]; then run_args+=(--model "$model"); fi
  if [ -n "$title" ]; then run_args+=(--title "$title"); fi
  run_args+=("$prompt")

  # Live transcript relay: default on when stderr is a terminal, so a human
  # watches the agent think; off for scripted/detached runs. The raw JSON event
  # stream is still written verbatim to result.json (via tee).
  local follow="${SANDBOX_FOLLOW:-auto}"
  case "$follow" in
    1|0) ;;
    *) if [ -t 2 ]; then follow=1; else follow=0; fi ;;
  esac
  if [ "$follow" = 1 ] && ! command -v python3 >/dev/null 2>&1; then
    log "note: python3 not found; live transcript disabled (files are still written)"
    follow=0
  fi

  log "task $runid: model=${model:-config-default} cpus=$CPUS mem=$MEM timeout=${TIMEOUT}s sealed=${sealed}$([ "$follow" = 1 ] && echo ' follow=on')"
  local rc=0
  # timeout runs inside the container so the remote process is actually killed.
  if [ "$follow" = 1 ]; then
    set +e
    docker exec "$sandbox" timeout -s TERM -k 30 "$TIMEOUT" opencode "${run_args[@]}" \
      2> "$run_dir/stderr.log" \
      | tee "$run_dir/result.json" \
      | python3 -u "$ROOT/journal.py" render >&2
    rc="${PIPESTATUS[0]}"
    set -e
  else
    docker exec "$sandbox" timeout -s TERM -k 30 "$TIMEOUT" opencode "${run_args[@]}" \
      > "$run_dir/result.json" 2> "$run_dir/stderr.log" || rc=$?
  fi

  # Record where the host output lives (the fixed prefix), for tooling.
  printf '%s\n' "$out_dir" > "$run_dir/hostout"

  if [ -n "$proxy_name" ]; then
    if container_has "$proxy_name" /var/log/tinyproxy.log; then
      stream_file_out "$proxy_name" /var/log/tinyproxy.log "$run_dir/proxy.log" \
        || docker logs "$proxy_name" > "$run_dir/proxy.log" 2>&1 || true
    else
      docker logs "$proxy_name" > "$run_dir/proxy.log" 2>&1 || true
    fi
  fi
  trap - EXIT INT TERM
  cleanup_task

  if [ "$rc" = 124 ]; then log "task $runid TIMED OUT after ${TIMEOUT}s"; fi
  log "task $runid finished (exit $rc)"
  log "  result : $run_dir/result.json"
  log "  stderr : $run_dir/stderr.log"
  log "  out    : $out_dir/ (host)"
  if [ -f "$run_dir/proxy.log" ]; then log "  proxy  : $run_dir/proxy.log"; fi
  # The `exit` marker is written last: `watch` follows it, and `peek` reads it
  # to report completion (rather than racing the container teardown).
  printf '%s\n' "$rc" > "$run_dir/exit"
  exit "$rc"
}

cmd_up() {
  require_docker
  build_images
  ensure_network "$NETWORK" internal

  # Fixed host output prefix for the session (never caller-chosen).
  local out_root out_dir
  out_root="$(prepare_out_root)"
  out_dir="$out_root/session"
  mkdir -p "$out_dir"

  local conf cfgdir
  cfgdir="$RUNS_DIR/_session/config"
  mkdir -p "$cfgdir"
  conf="$RUNS_DIR/_session/tinyproxy.conf"
  generate_config "$cfgdir"

  # Fast path: a RUNNING session is reused (docker ps lists only running ones).
  if session_running; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SESSION_PROXY"; then
      log "session proxy is not running; restarting it"
      write_proxy_conf "$conf" "$(network_subnet "$NETWORK")"
      start_proxy "$SESSION_PROXY" "$NETWORK" "$conf"
    fi
    ensure_relay "$NETWORK"
    # tmpfs state does not survive a restart, so re-seed the config if missing.
    if ! container_has "$SESSION" "$SESSION_CONFIG"; then
      log "session config missing; re-seeding it"
      stream_file_into "$SESSION" "$cfgdir/opencode.jsonc" "$SESSION_CONFIG"
      seed_state "$SESSION"
      seed_skills "$SESSION"
    fi
    if ! container_has "$SESSION" "/home/sandbox/.config/opencode/skills/webpage/SKILL.md"; then
      seed_skills "$SESSION"
    fi
    log "session $SESSION already running"
    log "  attach: opencode-sandboxed   (or: docker exec -it $SESSION opencode)"
    return 0
  fi

  # Stopped or absent: recreate. A stopped container has already lost its
  # tmpfs state (seeded config, workspace) and may hold stale gateway/network
  # state from before a reboot, so restarting it is not safe — only recreating.
  if session_exists; then
    log "session $SESSION exists but is not running; recreating it"
    docker rm -f "$SESSION" >/dev/null 2>&1 || true
  fi

  write_proxy_conf "$conf" "$(network_subnet "$NETWORK")"
  start_proxy "$SESSION_PROXY" "$NETWORK" "$conf"
  ensure_relay "$NETWORK"

  local create_flags env
  create_flags="$(worker_create_flags "$NETWORK")"
  env="$(worker_env "$SESSION_PROXY")"

  # /workspace/out is bind-mounted to the fixed host prefix.
  local -a mount_flags=(-v "$out_dir:/workspace/out:rw")

  # NOTE: --entrypoint overrides the image ENTRYPOINT (see cmd_task).
  # shellcheck disable=SC2086
  docker create --name "$SESSION" \
    $create_flags \
    $env \
    "${mount_flags[@]}" \
    --entrypoint sleep \
    -w /workspace \
    "$WORKER_IMAGE" infinity >/dev/null
  docker start "$SESSION" >/dev/null
  stream_file_into "$SESSION" "$cfgdir/opencode.jsonc" "$SESSION_CONFIG"
  seed_state "$SESSION"
  seed_skills "$SESSION"

  log "session up: $SESSION"
  log "  out   : $out_dir/ (host)"
  log "  interactive : opencode-sandboxed   (or: docker exec -it $SESSION opencode)"
  log "  one-shot    : docker exec $SESSION opencode run --standalone --auto \"message\""
}

cmd_down() {
  docker rm -f "$SESSION" >/dev/null 2>&1 || true
  docker rm -f "$SESSION_PROXY" >/dev/null 2>&1 || true
  log "session down"
}

cmd_logs() {
  local runid="${1:-}"
  if [ -z "$runid" ]; then log "usage: ./run.sh logs <run-id>"; exit 2; fi
  local f="$RUNS_DIR/$runid/proxy.log"
  if [ ! -f "$f" ]; then
    log "no proxy log for $runid (sealed run or missing artifacts)"
    exit 1
  fi
  cat "$f"
}

# Resolve a run id: an explicit one, else the newest still-running run, else
# the newest finished run. Prints the run id (status notes go to stderr).
resolve_run() {
  local arg="${1:-}" rid running
  if [ -n "$arg" ]; then printf '%s' "$arg"; return 0; fi
  running="$(docker ps --format '{{.Names}}' 2>/dev/null | sed -n 's/^sandbox-//p')"
  rid="$(ls -td "$RUNS_DIR"/run-* 2>/dev/null | while read -r d; do
           b="${d##*/}"
           printf '%s\n' "$running" | grep -qx "$b" && { printf '%s' "$b"; break; }
         done)"
  if [ -z "$rid" ]; then
    rid="$(ls -td "$RUNS_DIR"/run-* 2>/dev/null | head -1)"
    rid="${rid##*/}"
    [ -n "$rid" ] && log "note: no running run; using the newest finished run ($rid)"
  fi
  printf '%s' "$rid"
}

cmd_watch() {
  local session=0 from_start=0 arg=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --session)    session=1; shift ;;
      --from-start) from_start=1; shift ;;
      -*) log "unknown option for 'watch': $1"; exit 2 ;;
      *) arg="$1"; shift ;;
    esac
  done
  if [ "$session" = 1 ]; then
    session_running || { log "no running session (start one: opencode-sb up)"; exit 1; }
    if [ "$from_start" = 1 ]; then
      exec docker exec -i "$SESSION" python3 - watch --from-start "$arg" \
        < "$ROOT/session_journal.py"
    fi
    exec docker exec -i "$SESSION" python3 - watch "$arg" < "$ROOT/session_journal.py"
  fi
  local runid dir
  runid="$(resolve_run "$arg")"
  if [ -z "$runid" ]; then log "no runs in $RUNS_DIR"; exit 1; fi
  dir="$RUNS_DIR/$runid"
  [ -d "$dir" ] || { log "unknown run: $runid"; exit 2; }
  if ! command -v python3 >/dev/null 2>&1; then
    log "python3 not found; falling back to a raw tail of result.json"
    exec tail -f "$dir/result.json"
  fi
  exec python3 -u "$ROOT/journal.py" watch "$dir"
}

# List the running session's sessions (id, message count, age, title).
cmd_sessions() {
  session_running || { log "no running session (start one: opencode-sb up)"; exit 1; }
  exec docker exec -i "$SESSION" python3 - list < "$ROOT/session_journal.py"
}

# Bounded snapshot for a host agent: status + only the last N messages, so a
# peek never pulls the whole transcript into the caller's context.
cmd_peek() {
  local runid="" limit="" session=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --session) session=1; shift ;;
      -n|--lines) limit="${2:?}"; shift 2 ;;
      -*) log "unknown option for 'peek': $1"; exit 2 ;;
      *) runid="$1"; shift ;;
    esac
  done
  if [ "$session" = 1 ]; then
    session_running || { log "no running session (start one: opencode-sb up)"; exit 1; }
    exec docker exec -i "$SESSION" python3 - peek "$limit" "$runid" \
      < "$ROOT/session_journal.py"
  fi
  runid="$(resolve_run "$runid")"
  if [ -z "$runid" ]; then log "no runs in $RUNS_DIR"; exit 1; fi
  local dir="$RUNS_DIR/$runid"
  [ -d "$dir" ] || { log "unknown run: $runid"; exit 2; }
  command -v python3 >/dev/null 2>&1 || { log "python3 not found; cannot peek"; exit 1; }
  # Prefer the `exit` marker; only fall back to the container state (which lets
  # pre-marker runs and crashed runs read as finished).
  local state=""
  if [ ! -f "$dir/exit" ]; then
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "sandbox-$runid" \
      && state="running" || state="done"
  fi
  exec python3 -u "$ROOT/journal.py" peek "$dir" "$limit" "$state"
}

cmd_clean() {
  local names
  names="$(docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E '^(sandbox-|proxy-|opencode-sandbox-|model-relay-)' || true)"
  if [ -n "$names" ]; then
    # shellcheck disable=SC2086
    docker rm -f $names >/dev/null
    log "removed: $(echo "$names" | tr '\n' ' ')"
  else
    log "nothing to clean"
  fi
}

case "${1:-help}" in
  task)  shift; cmd_task "$@" ;;
  up)    cmd_up ;;
  down)  cmd_down ;;
  watch) shift; cmd_watch "$@" ;;
  peek)  shift; cmd_peek "$@" ;;
  sessions) cmd_sessions ;;
  logs)  shift; cmd_logs "$@" ;;
  models) shift; cmd_models "$@" ;;
  clean) cmd_clean ;;
  help|-h|--help) usage ;;
  *) log "unknown command: $1"; usage; exit 2 ;;
esac
