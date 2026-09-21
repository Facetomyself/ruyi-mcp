# ruyi-mcp reverse_ENV integration mirror

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp-reverse-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp-reverse-env/actions/workflows/ci.yml)
[![ruyiPage](https://img.shields.io/badge/ruyiPage-1.2.68-blue)](https://pypi.org/project/ruyiPage/1.2.68/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

本仓库是 reverse_ENV 的 Private integration mirror，基于 Public [`Facetomyself/ruyi-mcp`](https://github.com/Facetomyself/ruyi-mcp) 的 `788d7af28dd9ec4e91d79470cd30030aac3f8aba`，当前修复头为 `0.3.0-reverse-env.2`。它将 Firefox / WebDriver BiDi 浏览器控制、原生 JS debugger（DevTools RDP）、指纹分析、网络拦截、人类行为模拟与 evidence handoff 提供给 reverse_ENV；Public 仓库保持只读，不承载本地实现分支。

本项目由社区独立维护，是非官方集成，不代表 ruyiPage 官方项目。

## 核心能力

- 默认自动化 toolset 覆盖页面生命周期、拟人交互、指纹/代理、网络观察、Cookie、DOM、Frame、拦截、WebSocket、原生下载与 Session handoff。原生 debugger / 源码工具只在 `RUYI_MCP_TOOLSET=debug` 或 `all` 时出现。实验档 `RUYI_MCP_TOOLSET=agent` 暴露 `ruyi_observe` / `ruyi_act` 编号执行环；P0 不含 Jev，`goal_run` 仍为 runtime-pending。
- `page.debugger` 走 Firefox DevTools RDP（`--start-debugger-server`），由 debugger 自己在源 URL/行下端点，并支持 request-level XHR breakpoint：断点、条件断点、单步、调用栈、作用域、读源码、异常暂停。禁止 preload 注入 `debugger;`。
- 暂停态控制通过 Bridge 后台 worker 处理：`ruyi_evaluate_script`、DOM click 和 human action 可与 `ruyi_debug_wait_paused` 并行，随后由 `resume/step/scope` 控制；source actor 支持 eval/blob/多段 inline，源码窗口保留 `offset`/行范围语义。
- debugger pause/scope 是观察，不是 RuyiTrace browser fact。`ruyi_trace_*`、`traceEnabled` 和 Bridge Trace 状态均已删除；C++ DOMTrace 只由独立 Private `ruyitrace-mcp` 承担。
- 启动日志声明 `Evidence handoff: browser-session-handoff.v1` 与 `firefox-debugger`；不得把 BiDi 观察或 debugger 暂停表述为 Trace 证据面。
- `ruyi_export_session` 默认输出 Cookie-only 的 canonical `browser-session-handoff.v1`。Cookie 原值只写入项目 `evidence/web/handoff/<handoffId>/`，响应只包含 `evidence-pointer.v1`、脱敏代理端点和可验证的 browser/source 元数据。
- `ruyi_human_drag` 提供原子的拟人拖拽动作链；`ruyi_human_scroll` 使用单方向原生 wheel 小步滚动；`ruyi_human_click` 每次点击前释放陈旧 source，并使用“拟人轨迹 + 带最终坐标的短 click pulse”派发可信 down/up/click。
- `ruyi_set_fingerprint` 将 outer window、viewport 与 screen 分成显式参数，不再伪造 Firefox 原生窗口几何。
- `ruyi_select_frame.selector` 使用 ruyiPage 的 `iframe.contentWindow` 映射，可精确区分 `srcdoc` 或同 URL frame；返回的 `contextId` 必须由后续 evaluate、DOM 或 human 工具显式作为 `frameContextId` 传入，过期或其他标签页的 ID 会报错，绝不静默回退顶层页。
- `ruyi_capture_wait` 会把 ruyiPage 的单个 `CapturePacket`、`None` 或多包列表统一为 MCP 侧的 `packets` 数组。`metadata` 是默认模式且不申请 body DataCollector；需要 `schema` 或 `body` 必须在 `capture_start` 时显式启用；`schema` 只返回 body 字段名、长度和 hash，`body` 只能追加到显式 `outputFile` JSONL，不会经过 MCP response。
- `ruyi_attach_browser` 通过现有 Firefox BiDi 端口接管浏览器，不导航页面；接管会话与 bridge 超时恢复都不会再连带关闭 Firefox。
- 新建浏览器若未给 `profilePath`，Bridge 会在 `RUYI_MCP_PROFILE_ROOT` 下创建本次会话专属的受控临时 profile，并在正常 `ruyi_browser_quit` / stdio shutdown 时回收；smart fingerprint 的 `fpfile` 同样只写入该目录，不再跟随当前工作目录生成 `userdir_*`。
- `ruyi_capture_stop` 默认以有界 `discard` 清理；`mode=metadata` 可在清理前输出有上限的脱敏摘要，并回报 `observed` / `returned` / `discarded` / `bodyUnavailable`。
- `ruyi_set_download_behavior` 直接调用 Firefox BiDi `browser.setDownloadBehavior`；`allow + downloadPath` 会保存至本地指定目录，处理 Firefox 的本地保存确认，不绕过站点授权。
- `ruyi_intercept_wait` 默认只返回脱敏 metadata，并在取样后继续被拦截请求；`schema` / `body` 遵循同一 JSONL body 边界。
- Node.js MCP Server 通过常驻 Python JSON-RPC Bridge 调用 ruyiPage。
- Server/Bridge 生命周期由单一幂等 cleanup 链管理；stdin EOF、transport close、stdout/child stdin `EPIPE` 与 signal 竞争不会重复清理或遗留 pending call。
- 仓库跟踪 TypeScript 构建产物；依赖安装完成后，MCP Host 可直接从 `build/src/index.js` 启动。

## 环境要求

- Node.js 20 或更高版本。
- Python 3.10 或更高版本；当前已在 Python 3.13 上验证。
- `ruyiPage==1.2.68`，以及由 reverse_ENV 锁定的 `151-proxy` Firefox；不要运行 `python -m ruyipage install` 覆盖该 runtime（上游安装器仍指向 Firefox 155）。

## 兼容性

| ruyi-mcp | ruyiPage | Node.js | Python | 验证环境 |
|----------|----------|---------|--------|----------|
| `0.3.0-reverse-env.2` | `1.2.68` | `>=20` | `>=3.10` | native `page.debugger` RDP/XHR + MCP stdio debugger gate + concurrent pause control + redacted ruyi-debug evidence |
| `0.3.0-reverse-env.1` | `1.2.65` | `>=20` | `>=3.10` | native `page.debugger` RDP + 151-proxy debugger gate + debug toolset + 1.2.65 wheel lock |
| `0.2.0-reverse-env.2` | `1.2.62` | `>=20` | `>=3.10` | 1.2.62 启动/指纹/capture fallback 合同 + 默认 automation toolset + owned Firefox reap + 57-tool `all` snapshot |
| `0.2.0-reverse-env.1` | `1.2.56` | `>=20` | `>=3.10` | 49 Bridge contracts + 57 tools canonical snapshot + `browser-session-handoff.v1` fixture/parity + lifecycle gates |
| `v0.1.8` | `1.2.56` | `>=20` | `>=3.10` | 48 Bridge contracts + 59 tools 完整 schema snapshot + lifecycle gates + 同源/跨域 Firefox frame runtime gate |
| `v0.1.7` | `1.2.54` | `>=20` | `>=3.10` | MCP SDK 1.30.0 安全基线 + 27 Bridge contracts + 完整 128 KiB body runtime gate + 59 tools stdio smoke |
| `v0.1.6` | `1.2.54` | `>=20` | `>=3.10` | 27 Bridge contracts + 完整 128 KiB body runtime gate + 59 tools stdio smoke |
| `v0.1.5` | `1.2.54` | `>=20` | `>=3.10` | 21 Bridge contracts + 20 轮 capture runtime gate + 57 tools stdio smoke |
| `v0.1.4` | `1.2.54` | `>=20` | `>=3.10` | Bridge contract + TypeScript build + 57 tools stdio smoke |
| `v0.1.3` | `1.2.54` | `>=20` | `>=3.10` | 本地：Node.js 20 + Python 3.13 + `151-proxy` runtime gate |
| `v0.1.2` | `1.2.50` | `>=20` | `>=3.10` | GitHub Actions：Node.js 20 + Python 3.13 |

仓库对 `ruyiPage` 使用精确版本锁定。升级兼容版本前会重新执行 Bridge contract、TypeScript build、当前完整 tool schema snapshot、Session handoff contract、Server/Bridge lifecycle 与 Firefox runtime gates。

最新来源项目 release、commit、issue、PR、wheel parity 与升级决策见 [`docs/upstream-audit-2026-08-29.md`](docs/upstream-audit-2026-08-29.md)；1.2.62 适配见 [`2026-08-23` 审计](docs/upstream-audit-2026-08-23.md)；1.2.56 适配见 [`2026-07-30` 审计](docs/upstream-audit-2026-07-30.md)；MCP SDK 安全更新见 [`docs/dependency-security-2026-07-28.md`](docs/dependency-security-2026-07-28.md)。

## 安装

```bash
git clone https://github.com/Facetomyself/ruyi-mcp-reverse-env.git
cd ruyi-mcp-reverse-env
npm ci
python -m pip install -r requirements.txt
# 将 RUYI_FIREFOX_PATH 指向已验收的 reverse_ENV 151-proxy runtime。
# 不要运行 python -m ruyipage install；上游安装器会切到 Firefox 155。
npm run check
```

## 环境变量

- `RUYI_MCP_PYTHON`：Node Bridge 使用的 Python 可执行文件。Windows 默认使用 `python`，其他平台默认使用 `python3`。
- `RUYI_FIREFOX_PATH`：新建浏览器时使用的 Firefox 可执行文件路径。未设置时，Bridge 只检查 Windows RuyiPage 浏览器缓存和 `PATH`，绝不回退到 RuyiTrace runtime；`ruyi_attach_browser` 只接管现有 BiDi 端口，不要求本地 browser path。
- `RUYI_MCP_PROFILE_ROOT`：Bridge 自动创建的 disposable Firefox profile 根目录。必须是绝对路径；未设置时默认为 `<ruyi-mcp>/browser-profiles`。异常退出留下的残留也只会位于此处，且该目录被 Git 忽略。
- `RUYI_MCP_LOCAL_HEAD`：仅供无 `.git` 的 release 安装显式提供 Private mirror Git SHA；普通 checkout 会直接读取本地 HEAD。
- `RUYI_MCP_TOOLSET`：默认 `automation`（隐藏 debugger/源码工具，不启动 RDP）。`debug` / `all` / `expert` / `full` 暴露原生 debugger；`debug`/`all` 下 `ruyi_new_page` 默认 `enableDebugger=true`。`agent` 是实验 toolset：`new_page` / `attach` / `navigate` / `observe` / `act` / `quit` / `status` / `export_session` / `handle_cloudflare`。observe/act 不进入默认 automation 快照。
- `RUYI_MCP_DEBUG_EVIDENCE_ROOT`：可选外部项目 workspace 根目录；配置后 debugger 观察会以脱敏记录写入 `evidence/web/ruyi-debug/<runId>/observations.jsonl`。也可在首次 `ruyi_new_page` 传 `debugEvidenceRoot`、`debugCaseId`、`debugRunId`。

## 代理接入（reverse_ENV）

- `ruyi_new_page.proxy` 配置的是 Firefox 的第一跳，不是 Cliproxy provider 配置入口。
- 国内机器使用 Cliproxy 时，RuyiPage 只能拿到已启动且验收通过的本机 Cliproxy chained sidecar loopback listener，例如 `http://127.0.0.1:<sidecar-port>`。sidecar 内部应固定为 `RuyiPage → loopback sidecar → 海外 Clash 节点（dialer-proxy）→ Cliproxy → target`。
- 普通主 Clash mixed listener（例如 `http://127.0.0.1:7897`）本身不等于 Cliproxy relay。只有已显式配置并验证 `dialer-proxy → Cliproxy` 链时才可作为该第一跳；否则 Ruyi 只是走普通 Clash 出口，不是在使用 Cliproxy。
- 不得把 `*.cliproxy.io:3010`、Cliproxy provider 账号或密码直接传给 `ruyi_new_page`、`ruyi_set_proxy` 或 fingerprint proxy 字段。provider endpoint 和凭据只保留在被 Git 忽略的本地 sidecar 配置/运行环境中，不进入 MCP 参数、日志或仓库。
- 这是一条调用提醒，不增加运行时拦截，也不改变 Ruyi MCP 对其他明确指定代理的兼容能力；代理仍只能在 browser launch 时设置，切换须先 quit/relaunch。

## Firefox runtime 选择

- 本控制面不注册 `ruyi_trace_*`，也不接受 `traceEnabled`。RuyiPage 内存 BiDi Trace 不再冒充证据平面。
- ruyiPage `1.2.68` 的安装器默认下载 Firefox 155。reverse_ENV 控制面与 debugger 仍使用本地锁定的 `151-proxy`（1.2.68 direct + MCP gates 已过）。credentialed HTTP / SOCKS5 proxy 不得拿 Firefox 版本号推断；155 只作并列候选，默认不切换。
- 原生 debugger 必须在 launch 时 `enableDebugger=true`，写入 `--start-debugger-server` 与 loopback RDP 端口。暂停期间不要调用 `run_js` / 点击；看门狗默认 60 秒自动 resume。debugger 观察写入 `evidence/web/ruyi-debug/`，不得标成 ruyitrace。
- 新建会话显式 `allow_system_access(False)`，非 private 启动页为 `about:blank`，避免 Windows 提权会话自动加上 `--remote-allow-system-access`。
- `ruyi_browser_quit` 对 MCP 自己启动的 Firefox 会按 PID/profile 回收残留 `firefox.exe` / `plugin-container.exe`；attach 会话永不杀外部进程。
- [`Ruyi Trace v2.5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5) 的资产实际为 app `2.5.5` + Firefox `151.0a1`（BuildID `20260718144531`），只用于独立 C++ DOMTrace 证据平面。它不随本仓库分发，也不得设置为 `RUYI_FIREFOX_PATH`；reverse_ENV 通过 Private runtime lock 与 `ruyitrace-mcp` 单独管理。
- `windowSize` 只调整 outer window，inner/viewport 由 Firefox 原生计算；显式 viewport 与其 DPR 使用 `viewport`，显式 `screen.*` 使用 `screenSize`。`screenSize.devicePixelRatio` 仅作兼容输入并明确返回 `devicePixelRatioApplied: false`；`screenOrientation.angle` 同样保留输入但明确忽略。
- 自动化采集并发：实例数 = 健康出口 IP 数且不超过 4；单出口有风控窗口，耗尽后应换 IP 而不是加窗口。详见 reverse_ENV `article/collection-engineering/browser-collector-stability.md`。
- smart fingerprint 不再把 screen 尺寸写进 fpfile 或隐式 resize；Bridge 会在普通新标签页首次导航前重放 context-scoped overlays（screen 沿用同一 userContext），在 container 首跳前重放完整 fingerprint emulation，并拒绝把失败的 container 静默降级为普通标签页。
- 本仓库不分发 Firefox 二进制、浏览器 Profile 或 DOMTrace 内核。

可选的本地 runtime gate（不会访问外网）：

```powershell
$env:RUYI_FIREFOX_PATH='D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe'
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:capture-runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:attach-runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:download-runtime
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:debugger-runtime -- --headless
& 'D:\reverse_ENV\tools\node\npm.cmd' --prefix 'D:\reverse_ENV\mcp\ruyi-mcp' run check:debugger-mcp-runtime
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
        "RUYI_FIREFOX_PATH": "/absolute/path/to/firefox",
        "RUYI_MCP_PROFILE_ROOT": "/absolute/path/to/ruyi-mcp/browser-profiles"
      }
    }
  }
}
```

## 在 reverse_ENV 中使用

本 Private mirror 在 reverse_ENV 中以精确 gitlink 固定，首次使用时执行：

```powershell
git -C "D:\reverse_ENV" submodule update --init "mcp/ruyi-mcp"
& "D:\reverse_ENV\tools\node\npm.cmd" --prefix "D:\reverse_ENV\mcp\ruyi-mcp" ci
```

主仓通过 gitlink 固定已验证版本；修改本项目时，应先在子仓完成验证、提交和推送，再更新 reverse_ENV 主仓中的 gitlink。

## Session handoff

`ruyi_export_session` 必须接收 case 与项目 workspace，不能再用任意 `outputFile` 导出一坨 inline secret：

```json
{
  "caseId": "target-web-case",
  "workspaceRoot": "D:\\reverse_ENV\\workspace\\target-web-case"
}
```

默认调用会在 `evidence/web/handoff/<handoffId>/` 原子写入 canonical handoff 与 `cookies.json`。浏览器返回空 Cookie domain 时，仅允许从当前 HTTP(S) 页面 URL 的 hostname 推导 host-only domain；页面 origin 不明确或 Cookie name/domain 非法时直接 fail-closed。MCP 响应严格符合 `contracts/browser-session-handoff.v1.schema.json`，raw state 只通过带 bytes/SHA-256 的 `evidence-pointer.v1` 引用。attach 模式若无法发现 Firefox binary，需额外传绝对 `browserPath`，否则拒绝生成不可验证 handoff。

只有显式传入 `"include": ["cookies", "storage"]` 才会额外生成 `storage.json`。该 pointer 仅表示 control-plane observation；RuyiTrace v1 不支持 Storage import，handoff 不得声明 `storage-import`，consumer 遇到非空 local/session Storage 必须 fail-closed。

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

## Firefox Profile 边界

- `profilePath` 必须为绝对路径，且表示调用者管理的持久 profile；Bridge 不会在启动前清空它，也不会在退出时删除它。
- 未传 `profilePath` 的新建会话使用 Bridge 管理的 disposable profile。Bridge 将该路径同时传给 ruyiPage 与 `smart_fingerprint(userdir=...)`，避免 ruyiPage 在 MCP Host 的当前工作目录生成 `userdir_<timestamp>_<random>`。
- 需要保留登录态时，显式把 `profilePath` 放在 ignored 的项目 workspace；不得把 profile、Cookie、fpfile 或 capture 数据放在仓库根目录或提交到 Git。
- `ruyi_attach_browser` 只接管现有 Firefox；未给 `profilePath` 时不会创建任何 profile 目录。

## 验证

```bash
npm run check
npm audit --omit=dev
```

`npm run check` 会执行 TypeScript typecheck、Python 语法检查、Bridge contract、构建、automation/debug/all/agent toolset stdio smoke（当前 48/71/71 tools + agent 子集）、以及 Bridge/server/stdio 生命周期测试；该命令不会启动 Firefox。`npm run check:debugger-runtime` 是 direct ruyiPage gate；`npm run check:debugger-mcp-runtime` 进一步走 Node MCP → Python Bridge → BiDi/RDP 的完整首导航、并发暂停、sourceActor、native XHR、跨页断点、JSON-safe 值、disable/re-enable、源码 offset 和 evidence gate，需要本地已配置的 151-proxy runtime。`npm run check:capture-runtime` 使用本地 HTTP fixture 与真实 Firefox 连续验证 start/wait/stop，并断言 128 KiB response body 只写入临时 JSONL、不会回传 MCP response。`npm run check:download-runtime` 使用一次本地附件下载，确认 BiDi 下载目录配置能自动落盘并校验完整文件内容。`npm run check:agent-runtime` 用本地 `scripts/fixtures/agent-loop.html` 验收 `page.snapshot` / `page.act` 编号点击、输入和 select，不访问外网。

## 实验 toolset=agent（P0）

- 设置 `RUYI_MCP_TOOLSET=agent` 后，MCP 只暴露启动/导航/observe/act/quit/status/handoff/Cloudflare 子集。
- `ruyi_observe` 在页内扫可见可交互节点，返回编号表与 `snapshotId`。活引用留在页面；`ruyi_act` 用该轮几何，过期或节点消失返回 `miss`，`retried=false`。
- 宿主自己选 `op` + `index`。Jev / `ruyi_goal_run` 尚未接入，标 runtime-pending。
- 控制环成功不是 RuyiTrace browser fact，也不是 `serverAccepted`。
- automation 仍是 48 tools；采集器脚本无需迁移。

对内部命中区域不连续的链接（例如 Google Scholar 下一页），应选择实际可见的稳定子节点，不要点击外层 anchor 的几何中心。MCP stdio transport 关闭会进入 `bridge.stop()`；自建 SDK client 在关闭 stdio 前仍应先调用 `ruyi_browser_quit`，确保 attached browser 完成 detach-only。

## 数据与凭据边界

- Git 中不得提交凭据、Cookie、代理密钥、浏览器 Profile、抓取数据或运行时产物。
- `resultMode=body` 的 `outputFile` 应放入 ignored 的项目 workspace；其内容可能包含认证材料，不应回贴到 MCP 对话或提交到 Git。
- Session handoff 的 Cookie 原值与显式请求的 observation-only Storage 原值只允许存在于 ignored evidence 文件；handoff 本体固定 `redaction.inlineSecrets=false`。
- Python 与 Firefox 路径必须通过环境变量或运行时发现机制提供，不得提交开发者个人绝对路径。

## 来源与写入策略

- Public upstream：`https://github.com/Facetomyself/ruyi-mcp`，固定 base `788d7af28dd9ec4e91d79470cd30030aac3f8aba`，fetch-only，禁止 push branch/tag/release/workflow。
- Private integration：`https://github.com/Facetomyself/ruyi-mcp-reverse-env`，实现分支 `local/web-reverse-v2`，长期集成分支 `reverse-env/main`。
- 原项目 MIT License 与历史完整保留；本地控制面拆分只在 Private mirror 继续演进。

## License

MIT，详见 [LICENSE](LICENSE)。
