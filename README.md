# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.54-blue)](https://pypi.org/project/ruyiPage/1.2.54/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`ruyi-mcp` 是面向 [ruyiPage](https://github.com/LoseNine/ruyipage) 的社区 MCP Server，将 Firefox / WebDriver BiDi 浏览器自动化、运行时观察、指纹分析、Trace、网络拦截和人类行为模拟能力提供给 Claude Code、Codex、Cursor 等 MCP 客户端。

本项目由社区独立维护，是非官方集成，不代表 ruyiPage 官方项目。

## 核心能力

- 提供 59 个 MCP 工具，覆盖页面生命周期、脚本与运行时分析、网络抓取、Cookie、DOM、Frame、请求/响应拦截、WebSocket、浏览器指纹、人类行为模拟、Session 导出和 Trace。
- `ruyi_human_drag` 提供原子的拟人拖拽动作链；`ruyi_human_scroll` 使用单方向原生 wheel 小步滚动；`ruyi_human_click` 每次点击前释放陈旧 source，并使用“拟人轨迹 + 带最终坐标的短 click pulse”派发可信 down/up/click。
- `ruyi_set_fingerprint` 将 outer window、viewport 与 screen 分成显式参数，不再伪造 Firefox 原生窗口几何。
- `ruyi_select_frame.selector` 使用 ruyiPage 1.2.54 的 `iframe.contentWindow` 映射，可精确区分 `srcdoc` 或同 URL frame。
- `ruyi_capture_wait` 会把 ruyiPage 的单个 `CapturePacket`、`None` 或多包列表统一为 MCP 侧的 `packets` 数组，默认完整返回 body；只有显式设置 `maxBodyChars > 0` 才截断，并在 TypeScript 层按单包 RPC 排空批次。
- `ruyi_attach_browser` 通过现有 Firefox BiDi 端口接管浏览器，不导航页面；接管会话与 bridge 超时恢复都不会再连带关闭 Firefox。
- `ruyi_capture_stop` 会先清空 MCP 不再消费的队列/历史，再以 `cleanupTimeout` 有界释放 BiDi 订阅与 DataCollector，避免 stop 隐式补读全部 body。
- Node.js MCP Server 通过常驻 Python JSON-RPC Bridge 调用 ruyiPage。
- 仓库跟踪 TypeScript 构建产物；依赖安装完成后，MCP Host 可直接从 `build/src/index.js` 启动。

## 环境要求

- Node.js 20 或更高版本。
- Python 3.10 或更高版本；当前已在 Python 3.13 上验证。
- `ruyiPage==1.2.54`，以及由 ruyiPage 安装或兼容的 Firefox。

## 兼容性

| ruyi-mcp | ruyiPage | Node.js | Python | 验证环境 |
|----------|----------|---------|--------|----------|
| `v0.1.7` | `1.2.54` | `>=20` | `>=3.10` | MCP SDK 1.30.0 安全基线 + 27 Bridge contracts + 完整 128 KiB body runtime gate + 59 tools stdio smoke |
| `v0.1.6` | `1.2.54` | `>=20` | `>=3.10` | 27 Bridge contracts + 完整 128 KiB body runtime gate + 59 tools stdio smoke |
| `v0.1.5` | `1.2.54` | `>=20` | `>=3.10` | 21 Bridge contracts + 20 轮 capture runtime gate + 57 tools stdio smoke |
| `v0.1.4` | `1.2.54` | `>=20` | `>=3.10` | Bridge contract + TypeScript build + 57 tools stdio smoke |
| `v0.1.3` | `1.2.54` | `>=20` | `>=3.10` | 本地：Node.js 20 + Python 3.13 + `151-proxy` runtime gate |
| `v0.1.2` | `1.2.50` | `>=20` | `>=3.10` | GitHub Actions：Node.js 20 + Python 3.13 |

仓库对 `ruyiPage` 使用精确版本锁定。升级兼容版本前会重新执行 Bridge contract、TypeScript build 和 59 tools stdio smoke test。

最新浏览器上游 release、commit、issue、PR 与 Trace 取舍见 [`docs/upstream-audit-2026-07-27.md`](docs/upstream-audit-2026-07-27.md)；MCP SDK 安全更新见 [`docs/dependency-security-2026-07-28.md`](docs/dependency-security-2026-07-28.md)；`1.2.50...1.2.54` 的源码与 wheel 基线对比仍保留在 [`2026-07-18` 审计](docs/upstream-audit-2026-07-18.md)。

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
- `RUYI_FIREFOX_PATH`：新建浏览器时使用的 Firefox 可执行文件路径。未设置时，Bridge 会依次检查 reverse_ENV 便携目录、Windows RuyiPage 浏览器缓存和 `PATH`；`ruyi_attach_browser` 只接管现有 BiDi 端口，不要求本地 browser path。

## Firefox runtime 选择

- `ruyi_trace_*` 暴露的是 RuyiPage 内存中的 WebDriver BiDi JSON Trace，不是 Firefox 内核 DOMTrace。
- ruyiPage `1.2.54` 的安装器仍使用 `151-ruyi` runtime；如需验证 credentialed HTTP / SOCKS5 proxy，应单独下载上游 [`151-proxy`](https://github.com/LoseNine/ruyipage/releases/tag/151-proxy) release，并通过 `RUYI_FIREFOX_PATH` 显式指向解压后的 `firefox.exe`。
- [`Ruyi Trace v2.5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5) 的资产实际为 app `2.5.5` + Firefox `151.0a1`（BuildID `20260718144531`），只用于独立 C++ DOMTrace 链路。它不随本仓库分发、未通过 ruyiPage Bridge contract，**不得**设置为 `RUYI_FIREFOX_PATH`；reverse_ENV 通过 `tools\ruyitrace\ruyitrace.ps1` 和 runtime manifest 单独管理。
- `windowSize` 只调整 outer window，inner/viewport 由 Firefox 原生计算；显式 viewport 与其 DPR 使用 `viewport`，显式 `screen.*` 使用 `screenSize`。Firefox 可能忽略 `screenSize.devicePixelRatio`，Bridge 会区分 `requested` / `actual` / `devicePixelRatioApplied`，不会拿请求值冒充结果。
- smart fingerprint 不再把 screen 尺寸写进 fpfile 或隐式 resize；Bridge 会在普通新标签页首次导航前重放 context-scoped overlays（screen 沿用同一 userContext），在 container 首跳前重放完整 fingerprint emulation，并拒绝把失败的 container 静默降级为普通标签页。
- 本仓库不分发 Firefox 二进制、浏览器 Profile 或 DOMTrace 内核。

可选的本地 runtime gate（不会访问外网）：

```powershell
$env:RUYI_FIREFOX_PATH='D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe'
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:capture-runtime
```

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

## 接管已有 Firefox

Firefox 必须以 `--remote-debugging-port=<port>` 启动。MCP 重启后调用：

```json
{
  "address": "127.0.0.1",
  "port": 26700,
  "profilePath": "D:\\path\\to\\existing-profile"
}
```

`ruyi_attach_browser` 只连接现有 BiDi 端口，不创建进程、不导航当前标签页，并强制 `closeOnExit=false`。Firefox 同一时刻只允许一个 BiDi session；旧 bridge 必须先断开，但不得使用进程树终止把 Firefox 一并杀掉。

## 验证

```bash
npm run check
npm audit --omit=dev
```

`npm run check` 会执行 TypeScript typecheck、Python 语法检查、27 项 Bridge contract、构建和 59 tools stdio smoke test；该命令不会启动 Firefox。`npm run check:capture-runtime` 使用本地 HTTP fixture 与真实 Firefox 连续验证 start/wait/stop，并断言 128 KiB response body 不截断。

对内部命中区域不连续的链接（例如 Google Scholar 下一页），应选择实际可见的稳定子节点，不要点击外层 anchor 的几何中心。MCP stdio transport 关闭会进入 `bridge.stop()`；自建 SDK client 在关闭 stdio 前仍应先调用 `ruyi_browser_quit`，确保 attached browser 完成 detach-only。

## 数据与凭据边界

- Git 中不得提交凭据、Cookie、代理密钥、浏览器 Profile、抓取数据或运行时产物。
- Python 与 Firefox 路径必须通过环境变量或运行时发现机制提供，不得提交开发者个人绝对路径。

## License

MIT，详见 [LICENSE](LICENSE)。
