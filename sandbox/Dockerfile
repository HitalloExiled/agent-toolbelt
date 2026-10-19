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

# Headless GUI toolchain: Xvfb + software Vulkan (lavapipe) so Vulkan apps
# (e.g. emulators) can run without a GPU/display. Plus 7z (ISO userspace
# extraction) and X screenshot tools (xwd -> netpbm PNG).
RUN dnf install -y --setopt=install_weak_deps=False \
        xorg-x11-server-Xvfb xwd \
        mesa-vulkan-drivers vulkan-tools SDL2 p7zip netpbm-progs \
    && dnf clean all

# Headless browser with JavaScript: Chromium's headless shell (no window, no
# GPU) plus real fonts, so JS-gated pages render and screenshot correctly.
# Fedora ships the shell as /usr/lib64/chromium-browser/headless_shell.
RUN dnf install -y --setopt=install_weak_deps=False \
        chromium-headless google-noto-sans-fonts dejavu-sans-fonts \
    && dnf clean all \
    && ln -sf /usr/lib64/chromium-browser/headless_shell /usr/local/bin/chromium-headless

# shadPS4 (PlayStation 4 emulator) for headless game/ISO testing: the released
# Linux AppImage, unpacked (no FUSE in the sandbox), driven by bin/ps4 under
# Xvfb + lavapipe. Pinned by version AND checksum; bump both together.
ARG SHADPS4_VERSION=0.20.0
ARG SHADPS4_SHA256=be25d0324cd7b74068d32cdb66fa1b7b1e7bb499b062be51c7006d27d41d4255
RUN curl -fsSL -o /tmp/shadps4.zip \
        "https://github.com/shadps4-emu/shadPS4/releases/download/v.${SHADPS4_VERSION}/shadps4-linux-sdl-${SHADPS4_VERSION}.zip" \
    && echo "${SHADPS4_SHA256}  /tmp/shadps4.zip" | sha256sum -c - \
    && unzip -q /tmp/shadps4.zip -d /tmp/shadps4 \
    && chmod +x /tmp/shadps4/*.AppImage \
    && (cd /tmp/shadps4 && ./*.AppImage --appimage-extract >/dev/null) \
    && mv /tmp/shadps4/squashfs-root /opt/shadps4 \
    && chmod -R a+rX /opt/shadps4 \
    && rm -rf /tmp/shadps4 /tmp/shadps4.zip

# Sandbox CLIs for the agent (documented by the seeded skills).
COPY bin/webpage /usr/local/bin/webpage
COPY bin/ps4 /usr/local/bin/ps4
RUN chmod 755 /usr/local/bin/webpage /usr/local/bin/ps4

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
