# Upstream adoption audit — 2026-08-29

## Executive decision

Decision: **ADOPT PACKAGE / KEEP DEFAULT RUNTIME**.

- Adopt `ruyiPage==1.2.65` as `ruyi-mcp 0.3.0-reverse-env.1`.
- Keep the locally verified `151-proxy` Firefox as the default `RUYI_FIREFOX_PATH`.
- Native JS debugger (`page.debugger`) is Firefox DevTools RDP, **not** WebDriver BiDi and **not** CDP. It starts `--start-debugger-server` on loopback.
- 2026-08-29 151-proxy runtime gate: `set_breakpoint` → `wait_paused` (`why=breakpoint`) → `scope().x == 41` → `step_over` (`why=resumeLimit`) → `resume`.
- Do not run `python -m ruyipage install`. Installer still points at Firefox 155 (`v1.2.58`).
- Debugger observations are not RuyiTrace browser facts.

## Wheel lock

| Field | Value |
|-------|-------|
| Package | `ruyiPage==1.2.65` |
| Wheel | `ruyipage-1.2.65-py3-none-any.whl` |
| Bytes | 369118 |
| SHA-256 | `b91af7c781b0fc5097b5a7b29ec905feba7986597431c3faedd02d61f5bf88ac` |

## Upstream delta (1.2.62 → 1.2.65)

| Version | Why it matters |
|---------|----------------|
| 1.2.63 | Per-browser launch isolation; BiDi draft alignment |
| 1.2.64 | `page.debugger` native breakpoints / step / frames / scope |
| 1.2.65 | source text, object expand, pause on exception |

## `page.debugger` API (locked)

Requires `opts.enable_debugger(port=...)` **before** `FirefoxPage(opts)`, then `page.debugger.start()`.

| Method | Role |
|--------|------|
| `sources` / `source_text` / `breakable_lines` | executing source table |
| `set_breakpoint(url, line, column=None, condition=None)` | debugger plants the endpoint |
| `remove_breakpoint` / `clear_breakpoints` | |
| `wait_paused` / `pause` / `resume` | |
| `step_over` / `step_into` / `step_out` | |
| `frames` / `scope` / `expand` / `get_property` | paused inspection |
| `pause_on_exceptions` | |

Paused JS blocks BiDi (`run_js`, click, element text). Trigger in another thread; MCP sets `auto_resume_after=60`.

## Runtime matrix

| Candidate | Status |
|-----------|--------|
| Local `151-proxy` | Default. Debugger gate passed 2026-08-29. |
| Upstream Firefox 155 | Not required for debugger. Keep rejected as default (XPCOM / installer hash off). |

## Detection surface

Enabling debugger writes `devtools.debugger.remote-enabled`, `devtools.chrome.enabled`, and `--start-debugger-server`. RDP listens on loopback only (`force-local`). This is still not Chromium CDP, but it is a DevTools remote server. Default automation toolset does **not** start it.

## Evaluated and not accepted

- Soft `debugger;` / XHR Proxy injection: retired.
- Switching default `RUYI_FIREFOX_PATH` to 155.
- Equating debugger pause/scope with RuyiTrace C++ DOMTrace.
