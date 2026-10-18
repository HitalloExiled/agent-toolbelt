#!/usr/bin/env bash
#
# run.sh — orchestrate sandboxed OpenCode tasks in hardened, ephemeral containers.
#
#   ./run.sh task  --prompt "..." [options]   run one sandboxed task
#   ./run.sh up    [--out-dir DIR]             start a long-lived session container
#   ./run.sh down                              stop and remove the session container
#   ./run.sh logs  <run-id>                    show the egress proxy log of a run
#   ./run.sh models [--check]                  list the sandbox model catalog
#   ./run.sh clean                             remove orphaned sandbox/proxy containers
#
# Artifacts land in runs/<run-id>/: result.json, stderr.log, proxy.log, out/
# --out-dir DIR bind-mounts DIR rw at /workspace/out (scratch escape hatch).
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

log() { printf '[opencode-sandbox] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  ./run.sh task --prompt "..." [options]     run one sandboxed task
  ./run.sh up [--out-dir DIR]                start a long-lived session container
  ./run.sh down                              stop and remove the session container
  ./run.sh logs <run-id>                     show the egress proxy log of a run
  ./run.sh models [--check]                  list the sandbox model catalog (--check validates)
  ./run.sh clean                             remove orphaned sandbox/proxy containers

task options:
  --prompt TEXT         task prompt for the sandboxed agent
  --prompt-file FILE|-  read the prompt from a file ('-' = stdin)
  --copy-in PATH        copy a host file/dir into /workspace (repeatable)
  --out-dir DIR         bind DIR rw at /workspace/out (scratch escape hatch)
  --model REF           model ref (default: free online, local for --sealed)
  --title TEXT          session title
  --cpus N              CPU limit (default 4)
  --mem SIZE            memory limit (default 8g)
  --timeout SECS        hard timeout (default 1800)
  --sealed              no internet at all (internal-only network)
  --strict              fail if --model is not in the sandbox catalog
  --rebuild             rebuild the worker/proxy images before running

Environment: CPUS, MEM, TIMEOUT, OPENCODE_HOST_CONFIG, REBUILD
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
    --read-only --tmpfs /tmp \
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
  docker run -d --name "$1" \
    --network "$EGRESS_NETWORK" \
    --read-only --tmpfs /tmp --tmpfs /run --tmpfs /var/log \
    --cap-drop=ALL --security-opt no-new-privileges \
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
  sed "s|127\\.0\\.0\\.1:${BACKEND_PORT}|model-relay:${RELAY_PORT}|g" \
    "$HOST_CONFIG" > "$1/opencode.jsonc"
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
  docker create --name "$cname" --network none --entrypoint sleep \
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
    --tmpfs /tmp:rw,exec,mode=1777
    --tmpfs /workspace:rw,exec,uid=1000,gid=1000
    --tmpfs /home/sandbox/.local:rw,exec,uid=1000,gid=1000
    --tmpfs /home/sandbox/.cache:rw,exec,uid=1000,gid=1000
    --tmpfs /home/sandbox/.config:rw,exec,uid=1000,gid=1000
    --tmpfs /home/sandbox/.npm:rw,exec,uid=1000,gid=1000
    --tmpfs /home/sandbox/.bun:rw,exec,uid=1000,gid=1000
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

# Validate and canonicalize a host directory to bind-mount rw at /workspace/out
# (the escape hatch). It is a SCRATCH space — treat it as a tmp: the sandbox
# (untrusted code) can write/overwrite/delete anything inside it, there is no
# overwrite protection and no disk quota. Only point it at a disposable dir,
# never a system path or a precious tree. Docker creates a missing source dir
# as root (unwritable by the sandbox), so we create it ourselves as the user.
prepare_out_dir() { # $1 = host dir (relative or absolute) -> prints canonical path
  local d="$1"
  mkdir -p "$d" || { log "error: cannot create --out-dir '$d'"; exit 2; }
  d="$(cd "$d" && pwd -P)" || { log "error: cannot resolve --out-dir '$1'"; exit 2; }
  case "$d" in
    /|/home|/etc|/usr|/var|/boot|/root|/proc|/sys|/dev|/run|/bin|/sbin|/lib|/lib64|"$HOME")
      log "error: refusing to bind-mount '$d' rw; point --out-dir at a scratch subdir"
      exit 2 ;;
  esac
  [ -w "$d" ] || { log "error: --out-dir '$d' is not writable"; exit 2; }
  printf '%s' "$d"
}

session_running() { # a running session container (docker ps lists running only)
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SESSION"
}

session_exists() { # a session container in any state
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SESSION"
}

cmd_task() {
  local prompt="" prompt_file="" model="" title="" sealed=0 src strict="${STRICT:-0}"
  local out_dir=""
  local copy_in=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt)      prompt="${2:?}"; shift 2 ;;
      --prompt-file) prompt_file="${2:?}"; shift 2 ;;
      --copy-in)     copy_in+=("${2:?}"); shift 2 ;;
      --model)       model="${2:?}"; shift 2 ;;
      --title)       title="${2:?}"; shift 2 ;;
      --out-dir)     out_dir="${2:?}"; shift 2 ;;
      --cpus)        CPUS="${2:?}"; shift 2 ;;
      --mem)         MEM="${2:?}"; shift 2 ;;
      --timeout)     TIMEOUT="${2:?}"; shift 2 ;;
      --sealed)      sealed=1; shift ;;
      --strict)      strict=1; shift ;;
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

  if [ -n "$out_dir" ]; then out_dir="$(prepare_out_dir "$out_dir")"; fi

  local runid="run-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  local sandbox="sandbox-$runid"
  local net="$NETWORK" proxy_name="" conf=""
  local run_dir="$RUNS_DIR/$runid"
  mkdir -p "$run_dir/config"

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

  # Escape hatch: bind a host dir rw at /workspace/out so the sandbox's
  # deliverables land on the host directly (instead of the collected
  # runs/<id>/out copy). Scratch semantics — see prepare_out_dir.
  local -a mount_flags=()
  if [ -n "$out_dir" ]; then mount_flags+=(-v "$out_dir:/workspace/out:rw"); fi

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

  log "task $runid: model=${model:-config-default} cpus=$CPUS mem=$MEM timeout=${TIMEOUT}s sealed=${sealed}"
  local rc=0
  # timeout runs inside the container so the remote process is actually killed.
  docker exec "$sandbox" timeout -s TERM -k 30 "$TIMEOUT" opencode "${run_args[@]}" \
    > "$run_dir/result.json" 2> "$run_dir/stderr.log" || rc=$?

  # Collect /workspace/out unless it is the host escape hatch (then the files
  # are already on the host — copying would duplicate them).
  if [ -z "$out_dir" ] && container_has "$sandbox" /workspace/out; then
    stream_dir_out "$sandbox" /workspace/out "$run_dir"
  fi

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
  if [ -n "$out_dir" ]; then log "  out    : $out_dir/ (rw escape hatch — scratch, no quota)"; fi
  if [ -d "$run_dir/out" ]; then log "  output : $run_dir/out/"; fi
  if [ -f "$run_dir/proxy.log" ]; then log "  proxy  : $run_dir/proxy.log"; fi
  exit "$rc"
}

cmd_up() {
  local out_dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --out-dir) out_dir="${2:?}"; shift 2 ;;
      *) log "unknown option for 'up': $1"; usage; exit 2 ;;
    esac
  done

  require_docker
  build_images
  ensure_network "$NETWORK" internal
  if [ -n "$out_dir" ]; then out_dir="$(prepare_out_dir "$out_dir")"; fi

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
    fi
    log "session $SESSION already running"
    log "  attach: opencode-sandboxed   (or: docker exec -it $SESSION opencode)"
    if [ -n "$out_dir" ]; then
      log "note: --out-dir applies only to a newly created session; run 'opencode-sb down' first"
    fi
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

  # Escape hatch: bind a host dir rw at /workspace/out (see prepare_out_dir).
  local -a mount_flags=()
  if [ -n "$out_dir" ]; then mount_flags+=(-v "$out_dir:/workspace/out:rw"); fi

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

  log "session up: $SESSION"
  if [ -n "$out_dir" ]; then log "  out-dir: $out_dir/ (rw escape hatch — scratch, no quota)"; fi
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
  up)    shift; cmd_up "$@" ;;
  down)  cmd_down ;;
  logs)  shift; cmd_logs "$@" ;;
  models) shift; cmd_models "$@" ;;
  clean) cmd_clean ;;
  help|-h|--help) usage ;;
  *) log "unknown command: $1"; usage; exit 2 ;;
esac
