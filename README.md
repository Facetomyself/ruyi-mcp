# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.46-blue)](https://pypi.org/project/ruyiPage/1.2.46/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`ruyi-mcp` 是面向 [ruyiPage](https://github.com/LoseNine/ruyipage) 的社区 MCP Server，将 Firefox / WebDriver BiDi 浏览器自动化、运行时观察、指纹分析、Trace、网络拦截和人类行为模拟能力提供给 Claude Code、Codex、Cursor 等 MCP 客户端。

本项目由社区独立维护，是非官方集成，不代表 ruyiPage 官方项目。

## 核心能力

- 提供 56 个 MCP 工具，覆盖页面生命周期、脚本与运行时分析、网络抓取、Cookie、DOM、Frame、请求/响应拦截、WebSocket、浏览器指纹、人类行为模拟、Session 导出和 Trace。
- Node.js MCP Server 通过常驻 Python JSON-RPC Bridge 调用 ruyiPage。
- 仓库跟踪 TypeScript 构建产物；依赖安装完成后，MCP Host 可直接从 `build/src/index.js` 启动。

## 环境要求

- Node.js 20 或更高版本。
- Python 3.10 或更高版本；当前已在 Python 3.13 上验证。
- `ruyiPage==1.2.46`，以及由 ruyiPage 安装或兼容的 Firefox。

## 兼容性

| ruyi-mcp | ruyiPage | Node.js | Python | 验证环境 |
|----------|----------|---------|--------|----------|
| `v0.1.1` | `1.2.46` | `>=20` | `>=3.10` | GitHub Actions：Node.js 20 + Python 3.13 |

仓库对 `ruyiPage` 使用精确版本锁定。升级兼容版本前会重新执行 Bridge contract、TypeScript build 和 56 tools stdio smoke test。

## 安装

```bash
git clone https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
npm ci
python -m pip install -r requirements.txt
python -m ruyipage install
npm run check
```

## 环境变量

- `RUYI_MCP_PYTHON`：Node Bridge 使用的 Python 可执行文件。Windows 默认使用 `python`，其他平台默认使用 `python3`。
- `RUYI_FIREFOX_PATH`：Firefox 可执行文件路径。未设置时，Bridge 会依次检查 reverse_ENV 便携目录、Windows RuyiPage 浏览器缓存和 `PATH`。

## Firefox runtime 选择

- `ruyi_trace_*` 暴露的是 RuyiPage 内存中的 WebDriver BiDi JSON Trace，不是 Firefox 内核 DOMTrace。
- ruyiPage `1.2.46` 的安装器仍使用 `151-ruyi` runtime；如需验证 credentialed HTTP / SOCKS5 proxy，应单独下载上游 [`151-proxy`](https://github.com/LoseNine/ruyipage/releases/tag/151-proxy) release，并通过 `RUYI_FIREFOX_PATH` 显式指向解压后的 `firefox.exe`。
- 本仓库不分发 Firefox 二进制、浏览器 Profile 或 DOMTrace 内核。

## MCP 配置

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

## 在 reverse_ENV 中使用

`ruyi-mcp` 在 reverse_ENV 中以 Public Git submodule 维护，首次使用时执行：

```powershell
git -C "D:\reverse_ENV" submodule update --init "mcp/ruyi-mcp"
& "D:\reverse_ENV\tools\node\npm.cmd" --prefix "D:\reverse_ENV\mcp\ruyi-mcp" ci
```

主仓通过 gitlink 固定已验证版本；修改本项目时，应先在子仓完成验证、提交和推送，再更新 reverse_ENV 主仓中的 gitlink。

## 验证

```bash
npm run check
npm audit --audit-level=high
```

`npm run check` 会执行 TypeScript typecheck、Python 语法检查、Bridge contract、构建和 56 tools stdio smoke test；该命令不会启动 Firefox。

## 数据与凭据边界

- Git 中不得提交凭据、Cookie、代理密钥、浏览器 Profile、抓取数据或运行时产物。
- Python 与 Firefox 路径必须通过环境变量或运行时发现机制提供，不得提交开发者个人绝对路径。

## License

MIT，详见 [LICENSE](LICENSE)。
