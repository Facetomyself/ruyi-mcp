# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.54-blue)](https://pypi.org/project/ruyiPage/1.2.54/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`ruyi-mcp` is a community MCP server for [ruyiPage](https://github.com/LoseNine/ruyipage). It exposes Firefox / WebDriver BiDi browser automation, runtime inspection, fingerprint analysis, trace, network interception, and human-like interaction workflows to MCP clients such as Claude Code, Codex, and Cursor.

This project is independently maintained by the community. It is not an official ruyiPage integration and does not represent the ruyiPage project.

## Highlights

- 59 MCP tools covering page lifecycle, scripts and runtime inspection, network capture, cookies, DOM, frames, request and response interception, WebSocket, browser fingerprints, human-like interaction, session export, and trace workflows.
- `ruyi_human_drag` provides an atomic human-like drag chain. `ruyi_human_scroll` emits small native wheel steps in one direction. `ruyi_human_click` releases stale sources, runs a human trajectory, and finishes with a short click pulse that carries its own final coordinates.
- `ruyi_set_fingerprint` exposes outer-window, viewport, and screen sizing as separate operations instead of spoofing Firefox's native window geometry.
- `ruyi_select_frame.selector` uses ruyiPage 1.2.54's `iframe.contentWindow` mapping to distinguish `srcdoc` and same-URL frames precisely.
- `ruyi_capture_wait` normalizes ruyiPage's single `CapturePacket`, `None`, or multi-packet list into an MCP-side `packets` array. Bodies are complete by default; truncation is opt-in through `maxBodyChars > 0`, and batches are drained through one-packet bridge RPCs.
- `ruyi_attach_browser` attaches to an existing Firefox BiDi port without navigation. Attached sessions and bridge timeout recovery no longer terminate Firefox as part of a process tree.
- `ruyi_capture_stop` clears MCP-unconsumed queue/history first, then releases the BiDi subscription and DataCollector within `cleanupTimeout` instead of implicitly hydrating every body during stop.
- A Node.js MCP server backed by a persistent Python JSON-RPC bridge to ruyiPage.
- Tracked TypeScript build output, allowing MCP hosts to start directly from `build/src/index.js` after dependencies are installed.

## Requirements

- Node.js 20 or later.
- Python 3.10 or later; CI currently verifies Python 3.13.
- `ruyiPage==1.2.54` and a Firefox runtime installed by or compatible with ruyiPage.

## Compatibility

| ruyi-mcp | ruyiPage | Node.js | Python | Verified environment |
|----------|----------|---------|--------|----------------------|
| `v0.1.7` | `1.2.54` | `>=20` | `>=3.10` | MCP SDK 1.30.0 security baseline + 27 Bridge contracts + complete 128 KiB body runtime gate + 59-tool stdio smoke |
| `v0.1.6` | `1.2.54` | `>=20` | `>=3.10` | 27 Bridge contracts + complete 128 KiB body runtime gate + 59-tool stdio smoke |
| `v0.1.5` | `1.2.54` | `>=20` | `>=3.10` | 21 Bridge contracts + 20-cycle capture runtime gate + 57-tool stdio smoke |
| `v0.1.4` | `1.2.54` | `>=20` | `>=3.10` | Bridge contract + TypeScript build + 57-tool stdio smoke |
| `v0.1.3` | `1.2.54` | `>=20` | `>=3.10` | Local: Node.js 20 + Python 3.13 + `151-proxy` runtime gate |
| `v0.1.2` | `1.2.50` | `>=20` | `>=3.10` | GitHub Actions: Node.js 20 + Python 3.13 |

The repository pins an exact ruyiPage version. Before changing that compatibility target, the Bridge contract, TypeScript build, and 59-tool stdio smoke test are run again.

See [`docs/upstream-audit-2026-07-27.md`](docs/upstream-audit-2026-07-27.md) for the latest browser release, commit, issue, PR, and Trace adoption decisions, and [`docs/dependency-security-2026-07-28.md`](docs/dependency-security-2026-07-28.md) for the MCP SDK security update. The `1.2.50...1.2.54` source/wheel baseline remains in the [`2026-07-18` audit](docs/upstream-audit-2026-07-18.md).

## Installation

```bash
git clone https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
npm ci
python -m pip install -r requirements.txt
python -m ruyipage install
npm run check
```

## Environment Variables

- `RUYI_MCP_PYTHON`: Python executable used by the Node bridge. The default is `python` on Windows and `python3` on other platforms.
- `RUYI_FIREFOX_PATH`: Firefox executable path used for new launches. If unset, the bridge checks the reverse_ENV portable location, the Windows ruyiPage browser cache, and `PATH` in that order. `ruyi_attach_browser` only attaches to an existing BiDi endpoint and does not require a local browser path.

## Firefox Runtime Selection

- The `ruyi_trace_*` tools expose ruyiPage's in-memory WebDriver BiDi JSON trace, not Firefox kernel DOMTrace.
- The ruyiPage `1.2.54` installer still selects the `151-ruyi` runtime. To verify credentialed HTTP / SOCKS5 proxies, download the upstream [`151-proxy`](https://github.com/LoseNine/ruyipage/releases/tag/151-proxy) release separately and point `RUYI_FIREFOX_PATH` to the extracted `firefox.exe`.
- The [`Ruyi Trace v2.5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5) asset contains app `2.5.5` and Firefox `151.0a1` (BuildID `20260718144531`) for the independent C++ DOMTrace path only. It is not distributed by this repository, has not passed the ruyiPage bridge contract, and **must not** be configured as `RUYI_FIREFOX_PATH`; reverse_ENV manages it separately through `tools\ruyitrace\ruyitrace.ps1` and a runtime manifest.
- `windowSize` changes only the outer window while Firefox computes inner/viewport geometry naturally. Use `viewport` for an explicit viewport and its DPR, and `screenSize` for explicit `screen.*` emulation. Firefox may ignore `screenSize.devicePixelRatio`; the Bridge separates `requested` / `actual` / `devicePixelRatioApplied` instead of echoing a requested value as success.
- Smart fingerprinting no longer writes screen dimensions into fpfile or resizes implicitly. Before first navigation, the Bridge reapplies context-scoped overlays to normal tabs while preserving their shared user-context screen, reapplies the complete fingerprint to containers, and refuses to silently downgrade a failed container into a normal tab.
- This repository does not distribute Firefox binaries, browser profiles, or a DOMTrace-enabled browser kernel.

Optional local runtime gate (no external network access):

```powershell
$env:RUYI_FIREFOX_PATH='D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe'
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:capture-runtime
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
        "RUYI_FIREFOX_PATH": "/absolute/path/to/firefox"
      }
    }
  }
}
```

## Using the reverse_ENV Submodule

`ruyi-mcp` is maintained as a public Git submodule in reverse_ENV. Initialize it with:

```powershell
git -C "D:\reverse_ENV" submodule update --init "mcp/ruyi-mcp"
& "D:\reverse_ENV\tools\node\npm.cmd" --prefix "D:\reverse_ENV\mcp\ruyi-mcp" ci
```

The parent repository pins a verified commit through its gitlink. Make changes, validate, commit, and push in this repository before updating the reverse_ENV gitlink.

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

## Validation

```bash
npm run check
npm audit --omit=dev
```

`npm run check` runs TypeScript type checking, Python syntax checks, 27 Bridge contracts, the build, and a 59-tool stdio smoke test. It does not launch Firefox. `npm run check:capture-runtime` uses a local HTTP fixture and real Firefox to verify start/wait/stop cycles and asserts that a 128 KiB response body is not truncated.

For links with discontinuous internal hit regions, select a stable visible descendant instead of the outer anchor's geometric center. MCP stdio closure enters `bridge.stop()`; custom SDK clients should still call `ruyi_browser_quit` before closing stdio so an attached browser completes detach-only cleanup.

## Data and Credential Boundaries

- Do not commit credentials, cookies, proxy secrets, browser profiles, captured traffic, or runtime artifacts.
- Provide Python and Firefox paths through environment variables or runtime discovery. Do not commit developer-specific absolute paths.

## License

MIT. See [LICENSE](LICENSE).
