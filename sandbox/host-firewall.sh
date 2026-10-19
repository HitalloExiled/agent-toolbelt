#!/usr/bin/env bash
#
# host-firewall.sh — close the container -> host-services hole for the sandbox.
#
# WHY
#   Sandbox containers run untrusted, agent-driven code on an --internal Docker
#   bridge whose *gateway is the host itself*. Anything the host listens on
#   0.0.0.0 (or on the bridge IP) is therefore reachable from the sandbox,
#   bypassing the audited egress proxy. Container -> host traffic is local
#   delivery, so it is governed by the host INPUT path — NOT by
#   DOCKER-USER/FORWARD (that only sees forwarded traffic).
#
# WHAT
#   firewalld (primary): a policy with ingress=docker, egress=HOST,
#   target=DROP, plus a rich rule allowing only the model-relay port back to
#   the host. egress=HOST only matches traffic that terminates on the host, so
#   forwarded traffic (container -> internet through the proxy) is untouched.
#   Without firewalld: INPUT rules scoped to the sandbox subnets, allowing the
#   relay port and dropping the rest to each network's gateway.
#
# SCOPE
#   The firewalld policy covers the whole `docker` zone (every container on the
#   host). The sandbox is the untrusted party; other containers are
#   deterministic. To scope it later, put only the sandbox bridges in a zone
#   and set SANDBOX_FW_INGRESS_ZONE to that zone.
#
# USAGE
#   sudo ./host-firewall.sh install-unit   # one-time: persist + enable at boot
#   sudo ./host-firewall.sh apply          # install now + self-test
#   ./host-firewall.sh status              # read-only, no root needed
#   sudo ./host-firewall.sh remove         # remove rules/policy (keep unit)
#   sudo ./host-firewall.sh uninstall-unit # disable + remove the unit
#
# ENV
#   SANDBOX_RELAY_PORT       model-relay port (default 18090)
#   SANDBOX_FW_ALLOW_PORTS   extra "port" or "port/proto", space separated
#   SANDBOX_FW_INGRESS_ZONE  firewalld ingress zone (default docker)
#   SANDBOX_FW_NETWORKS      networks for the iptables fallback/self-test
#   SANDBOX_WORKER_IMAGE     image for the self-test (default opencode-sandbox:latest)
#   SANDBOX_FW_NETWORK       network for the self-test (default opencode-sandbox-net)
#
set -euo pipefail

SELF="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

POLICY="opencode-sandbox-host-guard"
UNIT_NAME="opencode-sandbox-firewall.service"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
LIB_PATH="/usr/local/lib/opencode-sandbox/host-firewall.sh"
STATE_DIR="/run/opencode-sandbox"
STATE_FILE="$STATE_DIR/host-firewall.state"

RELAY_PORT="${SANDBOX_RELAY_PORT:-18090}"
INGRESS_ZONE="${SANDBOX_FW_INGRESS_ZONE:-docker}"
ALLOW_PORTS="${SANDBOX_FW_ALLOW_PORTS:-}"
FW_NETWORKS="${SANDBOX_FW_NETWORKS:-opencode-sandbox-net opencode-sandbox-sealed}"
SELFTEST_IMAGE="${SANDBOX_WORKER_IMAGE:-opencode-sandbox:latest}"
SELFTEST_NET="${SANDBOX_FW_NETWORK:-opencode-sandbox-net}"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "must run as root: sudo $SELF $*"; }

firewalld_active() {
  command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1
}

policy_exists() {
  firewalld_active || return 1
  firewall-cmd --get-policies 2>/dev/null | tr ' ' '\n' | grep -qx "$POLICY"
}

# "18090/tcp" plus any extras. Extras without a protocol default to tcp.
port_specs() {
  printf '%s/tcp\n' "$RELAY_PORT"
  local p
  for p in ${ALLOW_PORTS:-}; do
    case "$p" in
      */*) printf '%s\n' "$p" ;;
      *)   printf '%s/tcp\n' "$p" ;;
    esac
  done
}

# --------------------------------------------------------------------------- #
# firewalld (primary)
# --------------------------------------------------------------------------- #

apply_firewalld() {
  # Rebuild from scratch so re-running converges even after config drift.
  if policy_exists; then
    firewall-cmd --permanent --delete-policy="$POLICY" >/dev/null
  fi
  firewall-cmd --permanent --new-policy="$POLICY" >/dev/null
  firewall-cmd --permanent --policy="$POLICY" --add-ingress-zone="$INGRESS_ZONE" >/dev/null
  firewall-cmd --permanent --policy="$POLICY" --add-egress-zone=HOST >/dev/null
  firewall-cmd --permanent --policy="$POLICY" --set-target=DROP >/dev/null

  local spec port proto
  while IFS= read -r spec; do
    port="${spec%%/*}"
    proto="${spec##*/}"
    firewall-cmd --permanent --policy="$POLICY" \
      --add-rich-rule="rule family=ipv4 port port=${port} protocol=${proto} accept" >/dev/null
  done < <(port_specs)

  firewall-cmd --reload >/dev/null
}

remove_firewalld() {
  if policy_exists; then
    firewall-cmd --permanent --delete-policy="$POLICY" >/dev/null
    firewall-cmd --reload >/dev/null
    log "removed firewalld policy '$POLICY'"
  fi
}

# --------------------------------------------------------------------------- #
# iptables (fallback when firewalld is absent)
# --------------------------------------------------------------------------- #

net_addrs() { # $1 = docker network -> "subnet gateway"
  docker network inspect "$1" \
    --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}' 2>/dev/null || true
}

apply_iptables() {
  command -v iptables >/dev/null 2>&1 \
    || die "neither firewalld nor iptables is available"
  local net addrs subnet gw
  for net in $FW_NETWORKS; do
    addrs="$(net_addrs "$net")"
    [ -n "$addrs" ] || { warn "network '$net' not found; skipping"; continue; }
    subnet="${addrs%% *}"
    gw="${addrs##* }"
    [ -n "$subnet" ] && [ -n "$gw" ] \
      || { warn "no subnet/gateway for '$net'; skipping"; continue; }

    # ACCEPT (relay) first, then DROP (everything else to that gateway).
    iptables -C INPUT -s "$subnet" -d "$gw" -p tcp --dport "$RELAY_PORT" \
      -m comment --comment "$POLICY" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 1 -s "$subnet" -d "$gw" -p tcp --dport "$RELAY_PORT" \
           -m comment --comment "$POLICY" -j ACCEPT
    iptables -C INPUT -s "$subnet" -d "$gw" \
      -m comment --comment "$POLICY" -j DROP 2>/dev/null \
      || iptables -I INPUT 2 -s "$subnet" -d "$gw" \
           -m comment --comment "$POLICY" -j DROP
    log "  iptables: $subnet -> $gw (relay $RELAY_PORT allowed, rest dropped)"
  done
}

remove_iptables() {
  command -v iptables >/dev/null 2>&1 || return 0
  local line
  while line="$(iptables -S INPUT 2>/dev/null | grep -F -- "--comment $POLICY" | head -1)" \
        && [ -n "$line" ]; do
    # shellcheck disable=SC2086
    iptables ${line/#-A /-D } || break
  done
}

# --------------------------------------------------------------------------- #
# state + self-test
# --------------------------------------------------------------------------- #

write_state() {
  mkdir -p "$STATE_DIR"
  chmod 0755 "$STATE_DIR"
  {
    echo "applied_at=$(date -Is)"
    if firewalld_active; then echo "mechanism=firewalld"; else echo "mechanism=iptables"; fi
    echo "policy=$POLICY"
    echo "ingress_zone=$INGRESS_ZONE"
    echo "relay_port=$RELAY_PORT"
    echo "allow_ports=$(port_specs | tr '\n' ' ')"
  } > "$STATE_FILE"
  chmod 0644 "$STATE_FILE"
}

relay_listening() { # $1 = gateway
  command -v ss >/dev/null 2>&1 || return 1
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -qx "$1:$RELAY_PORT"
}

selftest() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found; skipping self-test"
    return 0
  fi
  if ! docker image inspect "$SELFTEST_IMAGE" >/dev/null 2>&1; then
    warn "image $SELFTEST_IMAGE not built yet; skipping self-test"
    return 0
  fi
  local gw
  gw="$(docker network inspect "$SELFTEST_NET" \
    --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
  if [ -z "$gw" ]; then
    warn "network $SELFTEST_NET not found; skipping self-test"
    return 0
  fi

  local expect_relay=0
  if relay_listening "$gw"; then
    expect_relay=1
  else
    warn "relay not listening on $gw:$RELAY_PORT — checking the block only"
  fi

  log "self-test from a throwaway container on $SELFTEST_NET (gateway $gw):"
  if docker run --rm --network "$SELFTEST_NET" \
      --entrypoint python3 "$SELFTEST_IMAGE" -c '
import socket, sys
gw, relay, expect_relay = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1"
def probe(port):
    s = socket.socket(); s.settimeout(3)
    try:
        s.connect((gw, port)); return "open"
    except TimeoutError:
        return "timeout"
    except OSError as exc:
        return type(exc).__name__
    finally:
        s.close()
blocked, relay_state = probe(5355), probe(relay)
print(f"  host:5355   -> {blocked} (guard works only if timeout)")
print(f"  host:{relay} -> {relay_state}" + ("" if expect_relay else " (relay down; not asserted)"))
ok = blocked == "timeout" and (not expect_relay or relay_state == "open")
sys.exit(0 if ok else 1)
' "$gw" "$RELAY_PORT" "$expect_relay"; then
    log "  ✅ blocked as expected; relay reachable"
    return 0
  fi
  warn "self-test FAILED — the guard is not effective (probes above)"
  return 1
}

# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

cmd_apply() {
  local no_selftest=0
  [ "${1:-}" = "--no-selftest" ] && no_selftest=1
  require_root apply

  if firewalld_active; then
    remove_iptables
    apply_firewalld
    log "firewalld policy '$POLICY': ingress=$INGRESS_ZONE egress=HOST target=DROP"
    local spec
    while IFS= read -r spec; do log "  allow: $spec"; done < <(port_specs)
  else
    warn "firewalld is not active — using iptables (persist with install-unit)"
    apply_iptables
  fi

  write_state
  if [ "$no_selftest" = 0 ]; then
    if ! selftest; then
      warn "rolling back the guard because the self-test failed"
      remove_firewalld
      remove_iptables
      rm -f "$STATE_FILE"
      die "guard rolled back; nothing was left installed"
    fi
  fi
  log "✅ host firewall guard applied"
}

cmd_remove() {
  require_root remove
  remove_firewalld
  remove_iptables
  rm -f "$STATE_FILE"
  log "✅ host firewall guard removed"
}

cmd_status() {
  if command -v firewall-cmd >/dev/null 2>&1; then
    log "firewalld     : $(firewalld_active && echo active || echo 'not active')"
    if firewalld_active; then
      if policy_exists; then
        log "policy        : $POLICY (present)"
        firewall-cmd --policy="$POLICY" --list-all 2>/dev/null | sed 's/^/  /' || true
      else
        log "policy        : $POLICY (ABSENT — guard not installed)"
      fi
    fi
  else
    log "firewalld     : not installed"
  fi

  log "iptables      :"
  if command -v iptables >/dev/null 2>&1; then
    iptables -S INPUT 2>/dev/null | grep -F -- "--comment $POLICY" | sed 's/^/  /' \
      || log "  (none, or need root to read)"
  else
    log "  (iptables not installed)"
  fi

  if [ -f "$STATE_FILE" ]; then
    log "state file    : $STATE_FILE"
    sed 's/^/  /' "$STATE_FILE"
  else
    log "state file    : (absent)"
  fi
}

cmd_install_unit() {
  require_root install-unit
  install -d -m 0755 "$(dirname "$LIB_PATH")"
  install -m 0755 "$SELF" "$LIB_PATH"

  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=opencode-sandbox: block container -> host services (allow the relay)
Documentation=file://$LIB_PATH
After=firewalld.service docker.service
Wants=firewalld.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=SANDBOX_RELAY_PORT=$RELAY_PORT
ExecStart=$LIB_PATH apply --no-selftest
ExecStop=-$LIB_PATH remove

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  systemctl restart "$UNIT_NAME"
  if ! selftest; then
    warn "rolling back: disabling the unit and removing the guard"
    systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    remove_firewalld
    remove_iptables
    rm -f "$STATE_FILE"
    die "installation aborted (self-test failed)"
  fi
  log "✅ unit installed and started: $UNIT_PATH"
  log "   verify with: $SELF status"
}

cmd_uninstall_unit() {
  require_root uninstall-unit
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  rm -f "$LIB_PATH"
  log "✅ unit removed (rules left in place; run 'remove' to drop them)"
}

usage() {
  awk 'NR>2 { if ($0 ~ /^set -euo/) exit; sub(/^# ?/, ""); print }' "$SELF"
}

case "${1:-status}" in
  apply)          shift; cmd_apply "$@" ;;
  remove)         shift; cmd_remove "$@" ;;
  status)         cmd_status ;;
  install-unit)   cmd_install_unit ;;
  uninstall-unit) cmd_uninstall_unit ;;
  -h|--help|help) usage ;;
  *) die "unknown command: $1 (try: apply | remove | status | install-unit | uninstall-unit)" ;;
esac
