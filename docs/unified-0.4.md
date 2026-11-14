# 统一版本 0.4 迁移

唯一源码仓为 `Facetomyself/ruyi-mcp`。公开 main `66314a3` 与适配分支 `788d7af` 都是 integration 基线 `4d68d426` 的祖先；保留历史快进整合，不建立公开/私有功能分叉。发布须先完成历史内容审查和 Firefox159 全功能门禁。

## 接口迁移

| 旧行为 | 统一版本 |
|---|---|
| `debug/all` 自动附着 | 启动仅预留 RDP，显式附着默认 observe，再按需 armed |
| Python `page.debugger` | 仓库自有 TypeScript RDP，独立恢复通道 |
| 全量工具常驻或 handler 被裁剪 | compact 五入口；完整注册表保留，按需搜索和严格校验执行 |
| `all` 排除 observe/act | all 表示实际完整集合 |
| `ruyi_trace_*` | deprecated alias，正式 `ruyi_bidi_trace_*`；browser-wide BiDi 时间线 |
| 内联 capture body | metadata 默认；body 显式 JSONL，返回文件指针 |
| export 任意 outputFile | caseId/workspaceRoot 管理的 handoff，敏感 state 仅文件引用 |
| URL 猜目标或沿用暂停帧 | 精确目标、session epoch、pause ID，过期引用显式拒绝 |
| 151 历史验证 | Firefox159 build/hash 和真实 fixture gate |

旧 handoff service `ruyi-mcp-reverse-env` 仍可读取，新产物使用 `ruyi-mcp`。v1 的 publicBaseSha/localHeadSha 字段保留结构兼容。父仓 runtime-lock 的 privateControlPlane 也是兼容键名，其 repository 与 runtime 指向统一来源。

## 运行与取证

调试断点不注入页面代码。原生 API 不支持的目标组合返回 unsupported；不改成 XHR Proxy 或 preload 软断点。用户主动调用脚本求值、preload、网络拦截等自动化工具仍可能改变页面行为，与原生调试通路分别记录。

Trace 借用会话使用原 owner 的受控 descriptor、租约和自动化转发，RDP 独立附着同一进程。暂停默认 30 秒，lease 默认 120 秒、总窗口 600 秒。到期与停止先恢复/清理再交 owner flush；调试观察不自动升级为 browser fact 或业务成功。

source map、各类 worker、DOM/event/异常和暂停恢复必须分别运行 fixture。WASM 首版仅导出 binary 和观察 JS 边界。能力状态分开记录 reported/probed/verified，不用工具数量作为完整性证明。

shared worker 初始 form 可能无 URL，必须由调用方给出精确 `sharedWorkerUrls`；adapter 在
thread 附着后按实际 source 再绑定，拒绝同 origin 的其他 worker。native 不提供的 worker
出站请求断点、worker DOM mutation 和 async/generator restart 明确返回 unsupported。

## 仓库迁移

先验证统一源码、历史和运行时，再推送 canonical 提交与版本；父仓随后更新 URL 和精确 gitlink，并确认新提交可从 canonical 获取。最后冻结旧 mirror、停止其发布工作流、写迁移说明并归档。运行时二进制、Profile、trace、Cookie 和本机凭据不进入提交。
