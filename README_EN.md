# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.54-blue)](https://pypi.org/project/ruyiPage/1.2.54/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`ruyi-mcp` is a community MCP server for [ruyiPage](https://github.com/LoseNine/ruyipage). It exposes Firefox / WebDriver BiDi browser automation, runtime inspection, fingerprint analysis, trace, network interception, and human-like interaction workflows to MCP clients such as Claude Code, Codex, and Cursor.

This project is independently maintained by the community. It is not an official ruyiPage integration and does not represent the ruyiPage project.

## Highlights

- 57 MCP tools covering page lifecycle, scripts and runtime inspection, network capture, cookies, DOM, frames, request and response interception, WebSocket, browser fingerprints, human-like interaction, session export, and trace workflows.
- `ruyi_human_drag` provides an atomic human-like drag chain. `ruyi_set_fingerprint` exposes outer-window, viewport, and screen sizing as separate operations instead of spoofing Firefox's native window geometry.
- `ruyi_select_frame.selector` uses ruyiPage 1.2.54's `iframe.contentWindow` mapping to distinguish `srcdoc` and same-URL frames precisely.
- `ruyi_capture_wait` normalizes ruyiPage's single `CapturePacket`, `None`, or multi-packet list into an MCP-side `packets` array.
- A Node.js MCP server backed by a persistent Python JSON-RPC bridge to ruyiPage.
- Tracked TypeScript build output, allowing MCP hosts to start directly from `build/src/index.js` after dependencies are installed.

## Requirements

- Node.js 20 or later.
- Python 3.10 or later; CI currently verifies Python 3.13.
- `ruyiPage==1.2.54` and a Firefox runtime installed by or compatible with ruyiPage.

## Compatibility

| ruyi-mcp | ruyiPage | Node.js | Python | Verified environment |
|----------|----------|---------|--------|----------------------|
| `v0.1.4` | `1.2.54` | `>=20` | `>=3.10` | Bridge contract + TypeScript build + 57-tool stdio smoke |
| `v0.1.3` | `1.2.54` | `>=20` | `>=3.10` | Local: Node.js 20 + Python 3.13 + `151-proxy` runtime gate |
| `v0.1.2` | `1.2.50` | `>=20` | `>=3.10` | GitHub Actions: Node.js 20 + Python 3.13 |

The repository pins an exact ruyiPage version. Before changing that compatibility target, the Bridge contract, TypeScript build, and 57-tool stdio smoke test are run again.

See [`docs/upstream-audit-2026-07-18.md`](docs/upstream-audit-2026-07-18.md) for the release, commit, issue, PR, and Trace adoption audit behind this update.

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
- `RUYI_FIREFOX_PATH`: Firefox executable path. If unset, the bridge checks the reverse_ENV portable location, the Windows ruyiPage browser cache, and `PATH` in that order.

## Firefox Runtime Selection

- The `ruyi_trace_*` tools expose ruyiPage's in-memory WebDriver BiDi JSON trace, not Firefox kernel DOMTrace.
- The ruyiPage `1.2.54` installer still selects the `151-ruyi` runtime. To verify credentialed HTTP / SOCKS5 proxies, download the upstream [`151-proxy`](https://github.com/LoseNine/ruyipage/releases/tag/151-proxy) release separately and point `RUYI_FIREFOX_PATH` to the extracted `firefox.exe`.
- `windowSize` changes only the outer window while Firefox computes inner/viewport geometry naturally. Use `viewport` for an explicit viewport and its DPR, and `screenSize` for explicit `screen.*` emulation. Firefox may ignore `screenSize.devicePixelRatio`; the Bridge separates `requested` / `actual` / `devicePixelRatioApplied` instead of echoing a requested value as success.
- Smart fingerprinting no longer writes screen dimensions into fpfile or resizes implicitly. Before first navigation, the Bridge reapplies context-scoped overlays to normal tabs while preserving their shared user-context screen, reapplies the complete fingerprint to containers, and refuses to silently downgrade a failed container into a normal tab.
- This repository does not distribute Firefox binaries, browser profiles, or a DOMTrace-enabled browser kernel.

Optional local runtime gate (no external network access):

```powershell
$env:RUYI_FIREFOX_PATH='D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe'
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:runtime
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

## Validation

```bash
npm run check
npm audit --audit-level=high
```

`npm run check` runs TypeScript type checking, Python syntax checks, the Bridge contract, the build, and a 57-tool stdio smoke test. It does not launch Firefox.

## Data and Credential Boundaries

- Do not commit credentials, cookies, proxy secrets, browser profiles, captured traffic, or runtime artifacts.
- Provide Python and Firefox paths through environment variables or runtime discovery. Do not commit developer-specific absolute paths.

## License

MIT. See [LICENSE](LICENSE).
