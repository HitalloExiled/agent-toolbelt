---
name: webpage
description: Read or capture a web page with a real headless browser (Chromium, JavaScript enabled) inside the sandbox. Use when a page needs JS to render, when fetched HTML is an empty shell or a bot/consent wall, when you need the rendered DOM or visible text, or when the task asks for a screenshot or PDF of a URL. Commands: webpage text|dom|shot|pdf. It loads one URL per call and honours the sandbox egress proxy.
metadata:
  audience: sandbox-agent
---

# Headless browser (`webpage`)

`webpage` drives Chromium's headless shell: a full JS engine with no window.
It is the right tool when `curl`/`webfetch` return markup that only fills in
after scripts run, or when you must prove what a page actually shows.

```bash
webpage text URL [--wait MS] [--size WxH]   # visible text after JS
webpage dom  URL [--wait MS] [--size WxH]   # final DOM (HTML)
webpage shot URL FILE [--wait MS] [--size WxH]   # PNG screenshot
webpage pdf  URL FILE [--wait MS] [--size WxH]   # PDF (A4)
webpage version
```

## Examples

```bash
webpage text https://example.com
webpage text https://app.example.com --wait 8000        # slow SPA
webpage dom  https://example.com | grep -i '<title'
webpage shot https://example.com /workspace/out/page.png --size 1440,900
webpage pdf  https://example.com /workspace/out/page.pdf
webpage text "data:text/html,<script>document.body.textContent=1+1</script>"
```

## How it behaves

- **JS is on.** The page loads and its scripts run; `--wait` is the virtual
  time budget in milliseconds (default 3000). If text comes back empty or
  still looks like a placeholder, raise it (e.g. `--wait 10000`).
- **Network** goes through the sandbox egress proxy: Chromium gets
  `--proxy-server` from `HTTPS_PROXY`, because it ignores the usual env vars.
  In a `--sealed` run only `data:`, `file:` and other local URLs work.
- **No interaction.** One URL per call, no clicks/typing/logins. For a
  multi-step flow, drive the browser over CDP instead:
  `chromium-headless --headless --no-sandbox --remote-debugging-port=9222 ...`
  and talk to it with `python3` (the image has no Playwright/Puppeteer).
- **Output**: `text`/`dom` go to stdout; `shot`/`pdf` write a file and print
  its size to stderr. Put deliverables in `/workspace/out` — that is the only
  path that reaches the host.
- Exit code is non-zero on a missing URL, bad scheme (only http/https/file/data)
  or a failed screenshot. `WEBPAGE_TIMEOUT` (default 90s) bounds one load.

## Gotchas

- Bot protection (Cloudflare, Anubis) may still block a headless browser;
  a 403/consent page is the site's answer, not a tool failure. Try `dom` to
  see what was served, or find another source.
- The `shot` viewport is the window size (`--size`), not the full page.
- Downloading a file is not supported by `--dump-dom`; use `webfetch` or
  `curl` for plain downloads, or `page.pdf`/`shot` for a snapshot.
