# Upstream adoption audit — 2026-08-29

> The opening decision records the historical `.1` baseline. The superseding
> `.2` package lock and verification result are recorded at the end of this
> audit.

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

## Repair follow-up — 2026-08-30

The first `0.3.0-reverse-env.1` integration review found that a debugger
connection opened before the first navigation retained a dead RDP thread, and
that the synchronous Bridge reader could not accept `resume` while a paused
wait/trigger was running. The `.2` repair therefore:

- enables the RDP server at launch but attaches after the first navigation;
- dispatches JavaScript/evaluate, DOM and human triggers plus `wait_paused` on
  bounded daemon workers while serializing RDP socket commands;
- binds native breakpoint records to `pageIdx` and supports `sourceActor` for
  eval/blob/inline sources;
- preserves source `offset` windows and maps non-finite values to JSON-safe
  strings;
- clears stale debugger state on disable/close and supports an explicit zero
  watchdog;
- writes optional redacted `ruyi-debug` observations with a dedicated pointer
  contract; and
- adds a complete Node MCP runtime gate in
  `scripts/runtime_mcp_debugger.mjs`.

The gate must be rerun against the locked `151-proxy` runtime after any
ruyiPage upgrade. A green direct Python gate alone is insufficient.

## Superseding package lock — 2026-08-31

The `.2` repair is now locked to `ruyiPage==1.2.68`. The package exposes the
native Firefox RDP XHR/event breakpoint surface used by the MCP adapter; the
verified local runtime remains the reverse_ENV `151-proxy` Firefox rather than
the installer-managed Firefox 155 build.

| Field | Value |
|-------|-------|
| Package | `ruyiPage==1.2.68` |
| Wheel | `ruyipage-1.2.68-py3-none-any.whl` |
| Bytes | `372299` |
| SHA-256 | `f9a13ccd36a22ca71b23dd421031e85f98aa10805c6b1240cfbf9c74b2cf8e93` |
| Installer release tag | `v1.2.66` |
| Installer Firefox manifest | `155.0` |

The MCP contract pins this exact package and validates the manifest values.
The direct debugger gate and the full Node MCP gate both pass on `151-proxy`,
including post-navigation attach, source-actor eval handling, concurrent
pause/resume, native XHR pause, cross-page breakpoint ownership, JSON-safe
non-finite values, disable/re-enable cleanup, and redacted debugger evidence.
