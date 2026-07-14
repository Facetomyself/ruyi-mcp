# ruyi-mcp

Community MCP server for [RuyiPage](https://github.com/LoseNine/ruyipage), providing Firefox/WebDriver BiDi tooling for browser automation, runtime observation, fingerprint analysis, trace, network interception, and human-like interaction.

This is an unofficial community integration and is not the official RuyiPage project.

## Capabilities

- 56 MCP tools covering page lifecycle, script/runtime inspection, network capture, cookies, DOM, frames, request/response interception, WebSocket observation, fingerprints, human simulation, session export, and trace.
- Node.js MCP server with a long-lived Python JSON-RPC bridge.
- Tracked TypeScript build output so configured hosts can start from `build/src/index.js` after dependencies are installed.

## Requirements

- Node.js 20 or newer.
- Python 3.10 or newer; tested with Python 3.13.
- `ruyiPage==1.2.43` and a compatible Firefox installed by RuyiPage.

## Install

```bash
git clone https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
npm ci
python -m pip install -r requirements.txt
python -m ruyipage install
npm run check
```

Environment variables:

- `RUYI_MCP_PYTHON`: Python executable used by the Node bridge. Defaults to `python` on Windows and `python3` elsewhere.
- `RUYI_FIREFOX_PATH`: Firefox executable. If unset, the bridge checks a reverse_ENV portable location, the Windows RuyiPage browser cache, then `PATH`.

## MCP configuration

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

For `reverse_ENV`, initialize and install the submodule in place:

```powershell
git submodule update --init mcp/ruyi-mcp
& "D:\reverse_ENV\tools\node\npm.cmd" --prefix "D:\reverse_ENV\mcp\ruyi-mcp" ci
```

## Validation

```bash
npm run typecheck
python -m py_compile bridge/ruyi_bridge.py
npm run build
npm run smoke
npm audit --audit-level=high
```

The smoke test starts the MCP server over stdio and verifies that exactly 56 tools are registered; it does not launch Firefox.

## Security and data handling

- No credentials, cookies, proxy secrets, browser profiles, captures, or runtime artifacts belong in Git.
- Browser and Python paths must be supplied through environment variables or runtime discovery, never committed as developer-specific absolute paths.
- Use only in environments and against targets you are authorized to test.

## License

MIT
