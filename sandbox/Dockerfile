# Sandboxed OpenCode worker image.
#
# Built on the host; at runtime the container is fully hardened by run.sh
# (read-only rootfs, dropped caps, resource caps, no host mounts).
#
# Fedora-based to mirror the host (Fedora 44): dnf/rpm, SELinux-aware tooling
# and the standard Fedora paths, so tasks behave like on the real machine.
FROM fedora:44

# OpenCode version to install. Empty (default) tracks the latest release, so
# the sandbox catalog matches the host (free models are added/renamed over
# time). Pin for reproducibility: --build-arg OPENCODE_VERSION=2.0.32
ARG OPENCODE_VERSION=

ENV HOME=/home/sandbox \
    PATH=/home/sandbox/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Base tooling for the sandboxed agent (runs as non-root, so no dnf inside).
RUN dnf install -y --setopt=install_weak_deps=False \
        bash ca-certificates curl git ripgrep file jq unzip python3 nodejs tar \
    && dnf clean all

# OpenCode via the official v2 installer (latest, or a pinned version).
RUN if [ -n "$OPENCODE_VERSION" ]; then \
        curl -fsSL https://opencode.ai/v2/install \
            | bash -s -- --version "$OPENCODE_VERSION" --no-modify-path; \
    else \
        curl -fsSL https://opencode.ai/v2/install \
            | bash -s -- --no-modify-path; \
    fi

# Non-root user matching the host uid so docker-cp'd files keep sane ownership.
RUN useradd -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /workspace /home/sandbox/.config/opencode \
    && chown -R sandbox:sandbox /home/sandbox /workspace

WORKDIR /workspace
USER sandbox
ENTRYPOINT ["opencode"]
