---
name: ps4
description: Boot and test a PlayStation 4 game, ISO or game folder headlessly with shadPS4 (Xvfb + software Vulkan) inside the sandbox. Use when the task involves running a PS4 ISO/dump, checking whether a game boots, collecting emulator logs or screenshots, or reporting compatibility. It extracts ISOs, runs the emulator with a timeout, and writes the log and a PNG capture to /workspace/out.
metadata:
  audience: sandbox-agent
---

# PS4 testing (`ps4`)

`ps4` wraps [shadPS4](https://github.com/shadps4-emu/shadPS4) so a PS4 game
can run with **no GPU and no display**: Xvfb provides the screen and Mesa's
software Vulkan (lavapipe) provides the device. Expect very low frame rates —
this is for booting, screenshotting and reading logs, not for playing.

```bash
ps4 check                 # Xvfb, Vulkan, extractor, screenshot tools, emulator
ps4 run PATH [options]    # boot a game folder, eboot.bin, .iso or .pkg
ps4 version
```

`PATH` can be:

| Input | What happens |
|---|---|
| game folder | used as-is (searches 3 levels deep for `eboot.bin`) |
| `eboot.bin` | its parent folder is used |
| `.iso` | extracted with 7z into `--work`, then the `eboot.bin` folder runs |
| `.pkg` | handed to the emulator as-is (installing a PKG is a GUI flow) |

## Options

```bash
ps4 run /workspace/game.iso \
  --timeout 300 \                 # kill after 300s (default 180)
  --shot /workspace/out/boot.png \  # screenshot path (default <out>/ps4-<name>.png)
  --shot-after 60 \               # grab the frame at 60s (default 30)
  --log /workspace/out/boot.log \ # emulator log (default <out>/ps4-<name>.log)
  --work /workspace/out/game \    # where ISOs are extracted (default /tmp/ps4-work)
  --size 1920x1080                # virtual screen (default 1280x720)
```

Artifacts default to `/workspace/out`, the only path that reaches the host.

## Reading the result

1. **Exit**: `ps4` prints `emulator exit: N`, or `stopped after Ns (timeout)`
   when the game was still running. A timeout is normal for a game that boots
   and keeps rendering.
2. **Log**: always inspect it. Shader-compile spam is normal; look for
   `fatal`, `panic`, `not found`, module/firmware errors.
3. **Screenshot**: open the PNG to see whether anything rendered. A black
   frame plus a boot error in the log means it did not get far.

## Limits and caveats

- **Firmware is not bundled.** shadPS4 needs PS4 system modules for most
  games. Without them, boot stops early and the tool prints a hint. Do not
  try to download firmware from random sites; report that it is required.
- **Software rendering is slow.** A 3D game may take minutes to reach a
  menu; give it a generous `--timeout` and a later `--shot-after`.
- **Disk/RAM**: `/workspace` and `/tmp` are RAM-backed in this sandbox. A
  multi-GB ISO must first be in `/workspace` (copy_in), and extracting it
  doubles that usage — use `--no-extract` where the emulator can read the
  image directly, or a small test ISO, and watch out for OOM.
- **Not a compatibility oracle.** A failed boot can be the emulator, the
  firmware, the dump, or the timeout. Report the log evidence, not a verdict
  you cannot support.
