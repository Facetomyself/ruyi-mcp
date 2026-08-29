# ruyi-mcp reverse_ENV integration mirror

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp-reverse-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp-reverse-env/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.65-blue)](https://pypi.org/project/ruyiPage/1.2.65/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This repository is the Private reverse_ENV integration mirror based on Public [`Facetomyself/ruyi-mcp`](https://github.com/Facetomyself/ruyi-mcp) commit `788d7af28dd9ec4e91d79470cd30030aac3f8aba`. It provides Firefox / WebDriver BiDi browser control, runtime inspection, fingerprint analysis, network interception, human-like interaction, and evidence handoff for reverse_ENV. The Public repository remains read-only and never receives local implementation branches.

This project is independently maintained by the community. It is not an official ruyiPage integration and does not represent the ruyiPage project.

## Highlights

- Default automation toolset covers page lifecycle, humanized input, fingerprint/proxy, network observation, cookies, DOM, frames, interception, WebSockets, native downloads, and session handoff. Native debugger/source tools appear only with `RUYI_MCP_TOOLSET=debug` or `all`. The debugger plants breakpoints itself over Firefox DevTools RDP; it does not inject `debugger;`. Debugger observations are not RuyiTrace facts.
- The control plane no longer pretends to be a trace plane: `ruyi_trace_*`, `traceEnabled`, and Bridge trace state are removed. The independent Private `ruyitrace-mcp` owns RuyiTrace evidence capture.
- The startup log identifies only `Evidence handoff: browser-session-handoff.v1`; ruyiPage BiDi observation must not be presented as a Trace evidence plane.
- `ruyi_export_session` emits a Cookie-only canonical `browser-session-handoff.v1` by default. Raw cookies are written only under the project `evidence/web/handoff/<handoffId>/`; the response contains `evidence-pointer.v1`, a redacted proxy endpoint, and verifiable browser/source metadata.
- `ruyi_human_drag` provides an atomic human-like drag chain. `ruyi_human_scroll` emits small native wheel steps in one direction. `ruyi_human_click` releases stale sources, runs a human trajectory, and finishes with a short click pulse that carries its own final coordinates.
- `ruyi_set_fingerprint` exposes outer-window, viewport, and screen sizing as separate operations instead of spoofing Firefox's native window geometry.
- `ruyi_select_frame.selector` uses ruyiPage's `iframe.contentWindow` mapping to distinguish `srcdoc` and same-URL frames precisely. The returned `contextId` must be passed explicitly as `frameContextId` to later evaluate, DOM, or human tools; stale and cross-tab IDs fail instead of silently falling back to the top-level page.
- `ruyi_capture_wait` normalizes ruyiPage's single `CapturePacket`, `None`, or multi-packet list into an MCP-side `packets` array. `metadata` is the default and does not request a body DataCollector; `schema` or `body` must be enabled explicitly at `capture_start`; `schema` returns only body field names, length, and hash, while `body` can only append to an explicit `outputFile` JSONL and never travels in the MCP response.
- `ruyi_attach_browser` attaches to an existing Firefox BiDi port without navigation. Attached sessions and bridge timeout recovery no longer terminate Firefox as part of a process tree.
- When a new browser has no `profilePath`, the Bridge creates a session-owned disposable profile under `RUYI_MCP_PROFILE_ROOT` and removes it on normal `ruyi_browser_quit` / stdio shutdown. Smart-fingerprint `fpfile` data uses that same directory instead of creating `userdir_*` under the host working directory.
- `ruyi_capture_stop` uses bounded `discard` cleanup by default. `mode=metadata` returns a bounded, redacted summary before cleanup and reports `observed` / `returned` / `discarded` / `bodyUnavailable`.
- `ruyi_set_download_behavior` calls Firefox BiDi `browser.setDownloadBehavior` directly. `allow + downloadPath` saves to a local directory and handles Firefox's local save confirmation without bypassing site authorization.
- `ruyi_intercept_wait` returns redacted metadata by default and continues the intercepted request after sampling; `schema` / `body` follow the same JSONL body boundary.
- A Node.js MCP server backed by a persistent Python JSON-RPC bridge to ruyiPage.
- One idempotent cleanup chain owns the Server/Bridge lifecycle. Races between stdin EOF, transport close, stdout/child-stdin `EPIPE`, and signals neither duplicate cleanup nor strand pending calls.
- Tracked TypeScript build output, allowing MCP hosts to start directly from `build/src/index.js` after dependencies are installed.

## Requirements

- Node.js 20 or later.
- Python 3.10 or later; CI currently verifies Python 3.13.
- `ruyiPage==1.2.65` and reverse_ENV's locked `151-proxy` Firefox. Do not run `python -m ruyipage install` over that runtime; the upstream installer still targets Firefox 155.

## Compatibility

| ruyi-mcp | ruyiPage | Node.js | Python | Verified environment |
|----------|----------|---------|--------|----------------------|
| `0.3.0-reverse-env.1` | `1.2.65` | `>=20` | `>=3.10` | native `page.debugger` RDP + 151-proxy debugger gate + debug toolset + 1.2.65 wheel lock |
| `0.2.0-reverse-env.2` | `1.2.62` | `>=20` | `>=3.10` | 1.2.62 launch/fingerprint/capture-fallback contracts + default automation toolset + owned Firefox reap + 57-tool `all` snapshot |
| `0.2.0-reverse-env.1` | `1.2.56` | `>=20` | `>=3.10` | 49 Bridge contracts + canonical 57-tool snapshot + `browser-session-handoff.v1` fixture/parity + lifecycle gates |
| `v0.1.8` | `1.2.56` | `>=20` | `>=3.10` | 48 Bridge contracts + complete 59-tool schema snapshot + lifecycle gates + same-origin/cross-origin Firefox frame runtime gate |
| `v0.1.7` | `1.2.54` | `>=20` | `>=3.10` | MCP SDK 1.30.0 security baseline + 27 Bridge contracts + complete 128 KiB body runtime gate + 59-tool stdio smoke |
| `v0.1.6` | `1.2.54` | `>=20` | `>=3.10` | 27 Bridge contracts + complete 128 KiB body runtime gate + 59-tool stdio smoke |
| `v0.1.5` | `1.2.54` | `>=20` | `>=3.10` | 21 Bridge contracts + 20-cycle capture runtime gate + 57-tool stdio smoke |
| `v0.1.4` | `1.2.54` | `>=20` | `>=3.10` | Bridge contract + TypeScript build + 57-tool stdio smoke |
| `v0.1.3` | `1.2.54` | `>=20` | `>=3.10` | Local: Node.js 20 + Python 3.13 + `151-proxy` runtime gate |
| `v0.1.2` | `1.2.50` | `>=20` | `>=3.10` | GitHub Actions: Node.js 20 + Python 3.13 |

The repository pins an exact ruyiPage version. Before changing that compatibility target, it reruns the Bridge contract, TypeScript build, the current complete tool-schema snapshot, the session-handoff contract, Server/Bridge lifecycle, and Firefox runtime gates.

See [`docs/upstream-audit-2026-08-23.md`](docs/upstream-audit-2026-08-23.md) for the latest source-project releases, commits, issues, PRs, wheel parity, and upgrade decision. The 1.2.56 adaptation remains in the [`2026-07-30` audit](docs/upstream-audit-2026-07-30.md). Firefox 151 and Ruyi Trace 2.5.5 remain in the [`2026-07-27` audit](docs/upstream-audit-2026-07-27.md). See [`docs/dependency-security-2026-07-28.md`](docs/dependency-security-2026-07-28.md) for the MCP SDK security update.

## Installation

```bash
git clone https://github.com/Facetomyself/ruyi-mcp-reverse-env.git
cd ruyi-mcp-reverse-env
npm ci
python -m pip install -r requirements.txt
python -m ruyipage install
npm run check
```

## Environment Variables

- `RUYI_MCP_PYTHON`: Python executable used by the Node bridge. The default is `python` on Windows and `python3` on other platforms.
- `RUYI_FIREFOX_PATH`: Firefox executable path used for new launches. If unset, the Bridge checks only the Windows ruyiPage browser cache and `PATH`; it never falls back to a RuyiTrace runtime. `ruyi_attach_browser` only attaches to an existing BiDi endpoint and does not require a local browser path.
- `RUYI_MCP_PROFILE_ROOT`: absolute parent directory for disposable Firefox profiles owned by the Bridge. It defaults to `<ruyi-mcp>/browser-profiles`; residual profiles after an abnormal exit are confined there and the directory is Git-ignored.
- `RUYI_MCP_LOCAL_HEAD`: explicit Private-mirror Git SHA for release installs without `.git`; normal checkouts read local HEAD directly.
- `RUYI_MCP_TOOLSET`: default `automation` (hides debugger/source tools, does not start RDP). `debug` / `all` / `expert` / `full` expose the native debugger; `debug`/`all` default `ruyi_new_page.enableDebugger=true`.

## Proxy ingress in reverse_ENV

- `ruyi_new_page.proxy` configures Firefox's first hop; it is not a Cliproxy provider configuration entry point.
- On a domestic machine, RuyiPage may receive only a verified loopback listener of a started local Cliproxy chained sidecar, for example `http://127.0.0.1:<sidecar-port>`. The sidecar pins `RuyiPage → loopback sidecar → overseas Clash node (dialer-proxy) → Cliproxy → target`.
- The primary Clash mixed listener (for example `http://127.0.0.1:7897`) is not a Cliproxy relay by itself. Use it as that first hop only when an explicit, verified `dialer-proxy → Cliproxy` chain exists; otherwise Ruyi merely uses its ordinary Clash egress, not Cliproxy.
- Do not pass `*.cliproxy.io:3010`, a Cliproxy provider account, or provider credentials to `ruyi_new_page`, `ruyi_set_proxy`, or fingerprint proxy fields. Keep the provider endpoint and credentials only in Git-ignored local sidecar config/runtime state, never in MCP parameters, logs, or the repository.
- This is caller guidance, not a runtime block, and does not remove compatibility with other explicitly supplied proxies. A proxy still applies only at browser launch, so switching requires quit/relaunch.

## Firefox Runtime Selection

- This control plane does not register `ruyi_trace_*` or accept `traceEnabled`. The ruyiPage in-memory BiDi trace is no longer presented as an evidence plane.
- The ruyiPage `1.2.65` installer defaults to Firefox 155 (release `v1.2.58`). This control plane and debugger still use the locally locked `151-proxy` (debugger gate passed 2026-08-29). Never infer credentialed HTTP/SOCKS5 capability from the Firefox version string. Firefox 155 is a parallel candidate, not the default. Native debugger requires `enableDebugger=true` at launch. Debugger observations are not RuyiTrace facts.
- New owned sessions force `allow_system_access(False)` and use `about:blank` unless `privateMode` is set, so an elevated Windows token cannot silently add `--remote-allow-system-access`.
- `ruyi_browser_quit` reaps leftover `firefox.exe` / `plugin-container.exe` for MCP-owned processes by PID and managed profile; attach sessions never kill the external browser.
- The [`Ruyi Trace v2.5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5) asset contains app `2.5.5` and Firefox `151.0a1` (BuildID `20260718144531`) for the independent C++ DOMTrace evidence plane only. It is not distributed by this repository and must not be configured as `RUYI_FIREFOX_PATH`; reverse_ENV manages it through a Private runtime lock and `ruyitrace-mcp`.
- `windowSize` changes only the outer window while Firefox computes inner/viewport geometry naturally. Use `viewport` for an explicit viewport and its DPR, and `screenSize` for explicit `screen.*` emulation. `screenSize.devicePixelRatio` remains a compatibility input but explicitly returns `devicePixelRatioApplied: false`; `screenOrientation.angle` is likewise accepted and explicitly ignored.
- Automation collector concurrency: instance count equals healthy egress IPs and must not exceed 4. A single egress IP has a risk-control window; rotate the IP instead of adding windows. See reverse_ENV `article/collection-engineering/browser-collector-stability.md`.
- Smart fingerprinting no longer writes screen dimensions into fpfile or resizes implicitly. Before first navigation, the Bridge reapplies context-scoped overlays to normal tabs while preserving their shared user-context screen, reapplies the complete fingerprint to containers, and refuses to silently downgrade a failed container into a normal tab.
- This repository does not distribute Firefox binaries, browser profiles, or a DOMTrace-enabled browser kernel.

Optional local runtime gate (no external network access):

```powershell
$env:RUYI_FIREFOX_PATH='D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe'
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:capture-runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:attach-runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:download-runtime
```

## MCP Configuration

```json
{
  "mcpServers": {
    "ruyi-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ruyi-mcp/build/src/index.js"],
      "env": {
        "RUYI_MCP_PYTHON": "/absolute/path/to/python",
        "RUYI_FIREFOX_PATH": "/absolute/path/to/firefox",
        "RUYI_MCP_PROFILE_ROOT": "/absolute/path/to/ruyi-mcp/browser-profiles"
      }
    }
  }
}
```

## Using the reverse_ENV Submodule

This Private mirror is pinned by an exact reverse_ENV gitlink. Initialize it with:

```powershell
git -C "D:\reverse_ENV" submodule update --init "mcp/ruyi-mcp"
& "D:\reverse_ENV\tools\node\npm.cmd" --prefix "D:\reverse_ENV\mcp\ruyi-mcp" ci
```

The parent repository pins a verified commit through its gitlink. Make changes, validate, commit, and push in this repository before updating the reverse_ENV gitlink.

## Session Handoff

`ruyi_export_session` requires the Web case and project workspace. The legacy arbitrary `outputFile`/inline-secret export is retired:

```json
{
  "caseId": "target-web-case",
  "workspaceRoot": "D:\\reverse_ENV\\workspace\\target-web-case"
}
```

The default call atomically writes the canonical handoff and `cookies.json` under `evidence/web/handoff/<handoffId>/`. When the browser returns an empty Cookie domain, the exporter may derive a host-only domain only from the current HTTP(S) page URL hostname; an ambiguous origin or invalid Cookie name/domain fails closed. Its MCP response validates against `contracts/browser-session-handoff.v1.schema.json`; raw state is referenced only through `evidence-pointer.v1` records carrying byte counts and SHA-256. In attach mode, pass an absolute `browserPath` when the Firefox binary cannot be discovered, otherwise the exporter rejects an unverifiable handoff.

Only an explicit `"include": ["cookies", "storage"]` request writes `storage.json`. That pointer is a control-plane observation only: RuyiTrace v1 does not support Storage import, the handoff must not advertise `storage-import`, and consumers must fail closed on non-empty local/session Storage.

## Attaching to an Existing Firefox

Start Firefox with `--remote-debugging-port=<port>`, then call `ruyi_attach_browser` after the MCP bridge starts:

```json
{
  "address": "127.0.0.1",
  "port": 26700,
  "profilePath": "D:\\path\\to\\existing-profile"
}
```

The tool connects to the existing BiDi endpoint without creating a process or navigating the active tab, and forces `closeOnExit=false`. Firefox supports only one active BiDi session, so the previous bridge must disconnect first without terminating the Firefox process tree.

## Firefox Profile Boundary

- `profilePath` must be absolute and denotes a persistent caller-owned profile. The Bridge neither clears it before launch nor deletes it on exit.
- A new launch without `profilePath` uses a Bridge-owned disposable profile. The same path is passed to ruyiPage and `smart_fingerprint(userdir=...)`, so ruyiPage cannot create `userdir_<timestamp>_<random>` in the MCP host's current working directory.
- To preserve login state, put an explicit `profilePath` in an ignored project workspace. Never put profiles, cookies, fpfiles, or capture data in the repository root or commit them to Git.
- `ruyi_attach_browser` only attaches to an existing Firefox process; it does not create a profile when `profilePath` is omitted.

## Validation

```bash
npm run check
npm audit --omit=dev
```

`npm run check` runs TypeScript type checking, Python syntax checks, 49 Bridge contracts, the build, a 57-tool canonical-schema stdio smoke test, and Bridge/server/stdio lifecycle tests. It does not launch Firefox. `npm run check:capture-runtime` uses a local HTTP fixture and real Firefox to verify start/wait/stop cycles and asserts that a 128 KiB response body is written only to a temporary JSONL file, never returned through MCP. `npm run check:download-runtime` downloads one local attachment and verifies that the BiDi-configured directory receives the complete file automatically.

For links with discontinuous internal hit regions, select a stable visible descendant instead of the outer anchor's geometric center. MCP stdio closure enters `bridge.stop()`; custom SDK clients should still call `ruyi_browser_quit` before closing stdio so an attached browser completes detach-only cleanup.

## Data and Credential Boundaries

- Do not commit credentials, cookies, proxy secrets, browser profiles, captured traffic, or runtime artifacts.
- Put a `resultMode=body` `outputFile` in an ignored project workspace. Its content can contain authentication material and must not be pasted into MCP conversations or committed to Git.
- Raw Cookie values and explicitly requested observation-only Storage values may exist only in ignored evidence files; the handoff itself always has `redaction.inlineSecrets=false`.
- Provide Python and Firefox paths through environment variables or runtime discovery. Do not commit developer-specific absolute paths.

## Lineage and Write Policy

- Public upstream: `https://github.com/Facetomyself/ruyi-mcp`, fixed base `788d7af28dd9ec4e91d79470cd30030aac3f8aba`, fetch-only; pushing branches, tags, releases, or workflows is forbidden.
- Private integration: `https://github.com/Facetomyself/ruyi-mcp-reverse-env`, implementation branch `local/web-reverse-v2`, long-lived integration branch `reverse-env/main`.
- The original MIT License and full history remain intact; reverse_ENV control-plane evolution continues only in this Private mirror.

## License

MIT. See [LICENSE](LICENSE).
