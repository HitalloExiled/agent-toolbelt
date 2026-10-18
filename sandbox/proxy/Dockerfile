# Logging forward proxy for sandbox egress (tinyproxy).
# Config is mounted by run.sh at runtime (per-run subnet allow-list).
FROM fedora:44

RUN dnf install -y --setopt=install_weak_deps=False tinyproxy procps-ng \
    && dnf clean all

# -d: run in foreground (this build has no -f flag), -c: config file path
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
