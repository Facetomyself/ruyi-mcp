# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

[![CI](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Facetomyself/ruyi-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

统一的 Firefox 自动化与原生断点调试 MCP。自动化通过 ruyiPage / WebDriver BiDi，调试通过仓库自有 TypeScript RDP adapter。公开与本地部署使用相同源码和版本；旧 reverse_ENV mirror 的有效能力与提交历史并入本仓。

本项目由社区独立维护，不代表 ruyiPage 官方项目。浏览器二进制、Profile、凭据和运行产物不随仓库分发。

## 能力

- 自动化：页面、精确 iframe、DOM、Cookie、拟人点击/输入/拖拽/滚动、代理与指纹配置、网络捕获/拦截、WebSocket、下载、session handoff、observe/act。
- 原生调试：源码和可断位置、条件断点、logpoint、单步、run-to、同步 frame restart、调用栈、闭包、暂停帧求值、对象属性、异常、XHR/fetch、事件、DOM mutation、blackbox。
- 源码映射与多目标：source map 原源码断点，顶层页面、iframe 和 dedicated/shared/service worker。能力以实际 runtime 的 capabilities 和 fixture 验收为准，不能用工具注册代替运行验证。
- WASM：binary 导出与 JS 调用边界，不承诺指令级调试或 DWARF。
- 同 Trace 会话：借用原进程 RDP，自动化操作转发给唯一 BiDi owner；不另开浏览器或第二个控制会话。

原生调试不注入 `debugger;`，也不包装页面 XHR/fetch。它减少这类页面改写，不能保证不可检测或零开销。调试观察、BiDi 时间线与 C++ DOMTrace 是不同证据来源。

## 安装与运行时

需要 Node.js ≥20、Python ≥3.10 和 `ruyiPage==1.2.68`。统一版的首个验收运行时为 RuyiTrace 3.5.0 Firefox159 / BuildID `20261101193257`。运行其他 Firefox build 前需重新验证能力；历史 151 gate 不代表 159 已通过。

```bash
git clone https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
npm ci
python -m pip install -r requirements.txt
npm run check
```

设置 `RUYI_FIREFOX_PATH` 指向已校验的 Firefox159 可执行文件。不要用 `python -m ruyipage install` 静默替换锁定运行时。仓库跟踪构建产物，开发后执行 `npm run build`。

Linux 在同一仓库的 [`linux` 分支](https://github.com/Facetomyself/ruyi-mcp/tree/linux) 维护完整项目。独立部署、已验证范围和真机验收命令见 [Linux 迁移说明](docs/linux-port.md)；镜像分层、stdio 容器拓扑和验收顺序见 [Docker 设计](docs/docker-design.md)。

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
        "RUYI_MCP_PROFILE_ROOT": "/absolute/path/to/browser-profiles",
        "RUYI_MCP_TOOLSET": "compact"
      }
    }
  }
}
```

`compact` 常驻五个入口：`ruyi_browser_status`、`ruyi_observe`、`ruyi_act`、`ruyi_search_tools`、`ruyi_execute_tool`。搜索按需返回完整输入 schema；执行按目标工具 schema 严格校验，复用同一 handler。服务启动不启动浏览器，展示筛选不删除工具实现。

`automation`、`debug`、`agent` 保留场景化展示；`all` / `expert` / `full` 展示完整集合。无论哪个档位，启动 RDP 服务、附着调试器、启用暂停是三个独立动作。当前工具名与参数以 `tools/list` 和 `ruyi_search_tools` 为准。

## 原生调试工作流

1. 核对运行时 build/hash 和目标身份；启动时预留 loopback RDP，或接入受控 live-session descriptor。
2. 显式附着，初始 observe 模式跳过自动暂停；按 descriptor/context/browser 身份绑定，不能按 URL 猜标签页。
3. 搜索源码，设置精确 actor/URL 或 source-map 断点。首屏命中须先配置 watcher，再导航或创建 worker。
4. 并发触发页面与等待暂停；读所需 frame、scope、对象，随后 resume。暂停期间不发新的页面线程操作。
5. 默认暂停预算 30 秒；引用绑定 session epoch/pause ID，恢复、导航替换或重连后旧引用失效。请求超时会废弃 RDP 连接，避免迟到包串入下一次请求。
6. 清理本会话断点并 detach。外部浏览器由原 owner 关闭；不把 detach 等同于 RDP listener 已关闭。

shared worker 的初始 target 可能没有 URL。调用 `ruyi_debug_enable` 时必须提供精确
`sharedWorkerUrls` allowlist；adapter 在 thread 附着后按实际 source URL 再校验，不匹配就拒绝，
不会把同 origin 的其他 shared worker 纳入会话。

明确不支持的组合返回 unsupported，不使用脚本注入替代：worker 出站 XHR/fetch 请求断点、worker DOM mutation、async/generator frame restart。Service worker fetch 事件处理器仍可用代码断点。

source map 解析支持 simple/indexed map、内联数据和本地文件；远程 map 需显式允许，默认不携带 Cookie/Authorization，不自动跟随重定向。原源码断点绑定生成源码与 map hash；运行结束后不能恢复未捕获的历史 scope。

## 借用 Trace 活会话

将 Trace CLI `start --mcp --json` 返回的 `descriptorPath` 原样传给 `ruyi_attach_trace_session`。只传路径；文件内含进程私有 IPC 凭据。owner 提供 navigate/query/click/fill/press/scroll/wait/screenshot，RDP 独立处理暂停恢复。MCP 请求 120 秒排他租约，归还或到期只结束此次借用；Firefox 的关闭和采集收尾由 Trace 决定。

| 借用态契约 | 调用方如何判定 |
| --- | --- |
| 控制权与存活分开 | `ruyi_browser_status` 返回 `sessionMode:"borrowed"`、`browserState`、`leaseState`、`controlAvailable`。owner 仍就绪而租约失效时，`alive:true`、`leaseState:"revoked"`、`controlAvailable:false`。owner 未确认租约时是 `unknown/false`。以 `controlAvailable` 判断能否操作；同一借用一旦确认失效，即使迟到的状态响应报 active，也须重新借用。 |
| 页面范围严格匹配 | `ruyi_observe` / `ruyi_act` 只接受 `pageIdx:0` 和当前 owner 的顶层 BiDi `frameContextId`（两者均可省略）。其他范围返回 `UNSUPPORTED_SCOPE`，在发送任何 owner 请求前结束。`ruyi_navigate_page` 同样校验页号。快照携带 `runId` 与 `contextId`；重新借用后须重新 observe。 |
| 退出按真实效果返回 | 成功归还：`{"quit":true,"effect":"lease_released","owner":"ruyitrace","browserDisposition":"retained_by_owner"}`。已经失效则为 `lease_already_lost`。未确认归还的通信故障返回工具错误，保留借用以便重试。`retained_by_owner` 表示生命周期仍归 Trace 管理，而非额外探测到的存活证明。 |

描述文件消失时，已借用的客户端会报告 `publicationState:"missing"`、`controlAvailable:false`；缺少退出证据时，浏览器状态为 `unknown`，`quit` 返回 `ENOENT` 并保留原租约以便重试。Linux 上，只有在同一用户、同一 PID 命名空间内核实原运行的私有终态回执，且原 owner 与浏览器代际均已退出，状态才会显示 `alive:false`、`browserState:"exited"`、`leaseState:"revoked"`。此后旧页面操作返回 `OWNER_RETIRED`，`quit` 以 `lease_already_lost` 清除本地借用，同一客户端即可借用新的运行。单独重启 MCP 只会丢弃本地借用记录；owner 是否归还租约仍以其确认结果为准。

复现协议回归：`npm ci && npm run build && npm run check:borrowed-behaviors`。该测试通过 SDK stdio 运行真实 MCP，以可计数的回环 owner 验证响应、请求数和页面副作用，默认包含在 `npm run check`。

原生联验单独运行：在专用 Linux 容器中设置绝对路径 `TRACE_CLI`（已构建的 `bin/ruyitrace`）、`RUYI_FIREFOX_PATH`（同架构 R5 Firefox）、`TRACE_RECEIPT`（内核身份回执）和 `TRACE_ACCEPTANCE`（同包闸门验收回执）。构建 MCP 后执行 `npm run check:borrowed-native`。脚本创建本地测试页面，等待第二次借用的真实 120 秒租约耗尽，结果以 JSON 输出；正常回归不需要等待这个计时器。

最终 trace 索引依赖正常收尾，不能承诺 completed 后仍有原 live scope。调试和求值干预单独记录，业务验收使用恢复正常执行的路径。

## 数据与兼容性

- `ruyi_bidi_trace_start/stop/get_results` 是 browser-wide BiDi 命令/事件时间线。旧 `ruyi_trace_*` 是 deprecated alias，不是 C++ RuyiTrace。
- capture/intercept 默认只返回 metadata；body 必须显式写入 JSONL。响应中保留有界摘要、字节数、hash 或文件指针。
- `ruyi_export_session` 接收 `caseId` 与 `workspaceRoot`，Cookie 原值只写入 evidence 文件。Storage snapshot 是观察，不代表支持导入。
- `profilePath` 表示调用者管理的绝对持久目录；未提供时使用 `RUYI_MCP_PROFILE_ROOT` 内受控临时 profile。附着不会获得外部进程所有权。
- 自动化调用仍可显式使用 preload 或脚本求值；“原生调试不注入”仅指调试通路，不代表所有自动化工具都无页面干预。

详细迁移见 [统一版本说明](docs/unified-0.4.md)。`publicBaseSha`、`localHeadSha` 与父仓 runtime-lock 的 `privateControlPlane` 是兼容字段名，不再代表两套功能版本。

## 验证

```bash
npm run check
npm run check:rdp-runtime
npm run check:rdp-intervention
npm run check:runtime
npm run check:capture-runtime
npm run check:attach-runtime
npm run check:download-runtime
npm run check:agent-runtime
```

`check` 包含编译、Python contract、工具 schema、生命周期、RDP transport 和 source-map 单测，不启动浏览器。runtime gates 使用已配置的 Firefox 和本地 fixture；检查各自退出码与报告，不以历史版本结果代替本轮验收。完整统一版本还需同会话 owner IPC、lease/stop/flush、三类 worker 和四档干预对照门禁。

## 维护

唯一维护仓为 `Facetomyself/ruyi-mcp`，保留原公开仓与 integration mirror 的完整历史。源码验证和 canonical 提交可获取后，父仓才更新精确 gitlink；旧私有仓只保留迁移指针，不继续独立发布。历史适配审计保存在 `docs/upstream-audit-*.md`，其版本结论仅适用于当时 build。

MIT，详见 [LICENSE](LICENSE)。
