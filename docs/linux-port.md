# Linux 迁移与验收

`linux` 是同一个 GitHub 仓库中的长期维护分支，基线是 `main@c232a4b`。它保留 Node MCP、Python 桥接、WebDriver BiDi、原生 RDP、工具 schema、构建产物和全部历史；浏览器内核由 RuyiTrace 项目单独提供。

## 安装与控制面验证

```bash
git clone --branch linux https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export RUYI_MCP_PYTHON="$PWD/.venv/bin/python"
npm ci
npm run check
npm start
```

MCP 客户端通过 stdio 启动 `node /绝对路径/ruyi-mcp/build/src/index.js`，并使用同一个虚拟环境中的 Python 解释器。`npm run check` 覆盖 TypeScript 构建、Python 契约、MCP 工具列表、真实 Python 桥接冷启动、生命周期和 RDP 协议单测，验证过程无需 Firefox。

## 原生浏览器验收

指定与目标机器架构相同且已校验的 Linux Firefox。RuyiTrace 同会话和 DOMTrace 验收需要对应的 Linux RuyiTrace 内核及原会话 owner。系统 Firefox 的结果仅代表该 Firefox 构建。

```bash
export RUYI_FIREFOX_PATH=/绝对路径/ruyitrace-linux/firefox
file "$RUYI_FIREFOX_PATH"
sha256sum "$RUYI_FIREFOX_PATH"
"$RUYI_FIREFOX_PATH" --version
python scripts/run-automation-gates.py --firefox "$RUYI_FIREFOX_PATH" --output "$PWD/artifacts/automation"
npm run check:rdp-runtime
npm run check:rdp-intervention
```

自动化报告在 `artifacts/automation/`；RDP 和对照门禁默认在 `artifacts/rdp/`、`artifacts/rdp-intervention/` 写报告，分别可用 `RUYI_RDP_EVIDENCE_ROOT`、`RUYI_RDP_INTERVENTION_ROOT` 覆盖。RDP 门禁要求显式设置绝对可执行路径，配置缺失或无效时在启动 fixture 前以状态码 `2` 退出。保存每次测试使用的架构、Firefox 版本、Build ID 和 SHA-256，与报告一起核对。

## 当前状态

- Linux aarch64、Node 24.22.2、Python 3.10.12：`npm run check` 通过（64 项 Python、16 项 Node 测试及 MCP smoke）。构建产物与 Git 一致，生产 npm 依赖审计返回 0 项漏洞。
- 待验收：真实 Linux Firefox 上的 BiDi 自动化、RDP、Trace owner 会话和 DOMTrace。当前工作区的 RuyiTrace 3.5.0 内核是 Windows x86-64 PE；当前 Linux aarch64 主机没有原生 Firefox。Windows BuildID `20261101193257` 是历史基线，Linux build 的身份和能力以实际产物为准。

## 容器化

[Docker 设计](docker-design.md)把 MCP 控制面、原生 Firefox 和 Trace 同会话拆成三段验收。首版保留 stdio，由 MCP 客户端按需启动容器。文档内含拓扑、客户端配置草案、挂载与权限约定，以及 arm64/amd64 发布门禁；容器镜像仍待实现。

## 分支维护

已有工作副本在 `linux` 分支跟踪 `origin/linux`。纳入上游更新时，先拉取远端引用并快进同步维护分支，再合并 `origin/main`，执行上述验证并推送 `linux`；上游 `main` 独立维护。

```bash
git switch linux
git fetch origin
git merge --ff-only origin/linux
git merge origin/main
. .venv/bin/activate
npm run check
git diff --exit-code -- build
git push origin linux
```
