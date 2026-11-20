# ruyi-mcp Linux Docker 设计

**建议先做 `core` 控制面镜像，再做带原生 Firefox 的 `browser` 镜像。** 浏览器上线后，默认由同一个容器里的 MCP 持有浏览器。RuyiTrace 借用会话是另一条运行链，等原生 Trace 内核就绪后单独验收。本文是设计稿；目前尚未提交 Dockerfile、构建或发布镜像。宿主机已通过的检查见 [Linux 迁移与验收](linux-port.md)。

## 1. 三个交付物，按能力独立升级

| 交付物 | 内容 | 通过后能声明的能力 |
| --- | --- | --- |
| `core` OCI 镜像 | Node、已构建 MCP、Python 虚拟环境、ruyiPage | MCP `initialize`、工具发现、真实 Python 桥接、无浏览器启动状态；工具存在与实际能力是两回事 |
| `browser` OCI 镜像 | 基于同一 `core`，添加目标架构的 Linux Firefox 运行目录及系统依赖 | 使用该 Firefox 构建在本地 fixture 验收 BiDi、下载、回收、RDP；记录实际通过的能力 |
| RuyiTrace Linux 运行时 | Trace 项目交付内核与 owner，含实际 Firefox BuildID、架构、运行目录和校验清单 | Trace owner 同会话、DOMTrace 和输出封存；普通 Firefox 结果与此分开记录 |

开发调试可先把经校验的**完整浏览器目录**只读挂载到 `/opt/firefox`，并确保镜像层已有匹配的系统动态库。正式发布使用架构匹配的浏览器镜像层，选定基础镜像 digest 与浏览器制品版本并记录校验结果，避免容器启动时下载或切换内核。Windows `.exe` 与 Linux ELF 属于不同 ABI，`--platform` 选择的是镜像架构，无法把 Windows 内核变成 Linux 内核。

## 2. 首版拓扑：MCP 客户端按需启动容器

```text
宿主 MCP 客户端
     │ MCP stdio（docker run --rm -i）
     ▼
单个 Linux 容器
     Node MCP ── stdin/stdout ── Python bridge
         │                           │
         │ RDP / loopback            │ BiDi / loopback
         └──────────── Firefox ◄─────┘
                         │
                     出站网络
```

- 每个 MCP 客户端会话启动一个容器。使用 `-i` 保持 stdin 打开、`--init` 转发信号与回收孤儿；省略 TTY，保留 stdout 的 MCP 协议流，日志走 stderr。镜像采用 exec 形式入口，直接启动 Node。
- 第一版仍用 stdio，Docker 无需暴露 HTTP、BiDi 或 RDP 端口。纯 smoke 可以跑在 `--network=none`；真实浏览器先用同容器 loopback fixture，有外网需求再为该容器配置独立的出站策略。
- 当前 `ruyi_new_page` 的 `headless` 默认是 `false`。容器首次建页时显式传 `headless: true`，避免依赖 X11/Wayland。是否加 Xvfb 放在确有 headed 验收需求后。
- 运行 MCP 客户端的宿主进程需要 Docker 启动权限。优先专用账号与 rootless Docker；应用容器内只运行 MCP、桥接和由它管理的浏览器进程。

### 客户端配置草案

下面的镜像、用户和目录是**设计约定**，以镜像实现和发布为前提。宿主先建证据目录，并让容器中 UID 10001 有写权限（rootless 采用实际 UID 映射）。面向专用 fixture 的运行可以额外传 `--network=none`。

```json
{
  "mcpServers": {
    "ruyi-mcp-linux": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i", "--init",
        "--user", "10001:10001",
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--shm-size", "256m", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true",
        "--mount", "type=bind,src=/absolute/host/ruyi-evidence,dst=/evidence",
        "-e", "HOME=/tmp",
        "-e", "RUYI_MCP_PYTHON=/opt/venv/bin/python",
        "-e", "RUYI_MCP_PROFILE_ROOT=/tmp/ruyi-profiles",
        "-e", "RUYI_FIREFOX_PATH=/opt/firefox/firefox",
        "-e", "RUYI_MCP_TOOLSET=compact",
        "[browser-image@sha256:digest]"
      ]
    }
  }
}
```

`--shm-size=256m` 和 `/tmp` 512 MiB 是首轮测量值；根据 worker、截图和下载门禁的峰值再定额。若沙箱启动失败，优先记录 `userns`、seccomp、内核及 Firefox 报错，按最小权限解决；保留 Firefox 沙箱。读取或写入证据的工具参数使用容器看到的路径（例如 `/evidence/case-001`），MCP 客户端需通过宿主挂载点取回文件；下载目录也显式指定容器内路径。

## 3. 镜像与状态边界

1. **构建**：用 glibc 系基础镜像固定 Node/Python 版本。多阶段构建运行 `npm ci`、Python 固定版本依赖安装、构建与 `npm run check`，运行层保留 `build/`、生产 Node 依赖、Python 虚拟环境、`bridge/` 和契约文件。Python 的传递依赖也纳入镜像锁定；用相同目标架构、系统与虚拟环境路径构建和运行。
2. **数据**：默认 profile 在 `/tmp/ruyi-profiles` 随容器回收。只有明确需要复用会话时，给一个 Firefox owner 分配专属持久 profile；并发容器分开 profile。证据和下载与 profile 分别挂载，按业务维护保留期。源码树、Docker socket 和整份宿主 `$HOME` 留在挂载范围之外。
3. **身份和权限**：应用采用非 root UID、只读根文件系统和独立可写目录。浏览器制品目录只读；凭据与 live-session descriptor 由运行时权限受限目录提供，排除在构建上下文、镜像层和日志之外。浏览器容器的出站策略保护宿主及内部网段；默认 bridge 网络本身没有按目标域名过滤的能力。
4. **发布**：`core` 优先在原生 `linux/arm64` 和 `linux/amd64` runner 构建与验证，再发布多架构 manifest。`browser` 按可用浏览器制品分别验收，只有通过的架构进入标签。QEMU 可用于辅助构建，浏览器进程生命周期和 Firefox 沙箱以原生平台结果为准。部署按镜像 digest 固定版本并保留上个通过验证的 digest 供回滚。

## 4. Trace 与共享服务是后续两条独立演进路径

**Trace 共会话。** 当前 descriptor 的 owner IPC 和 RDP 都以 loopback 为边界；另一个容器的 `127.0.0.1` 指向它自己，只共享挂载目录接不到原 owner。首选让 Trace owner、它的 Firefox 和 `ruyi-mcp` 同处一个容器。以后要分两个镜像，MCP 可以通过 Compose `network_mode: service:trace-owner` 加入 owner 的网络命名空间，并只读共享 descriptor 目录。两种部署均由 Trace owner 独占 BiDi 和浏览器生命周期；MCP 只获取 lease、用 owner IPC 操作、用 RDP 调试，再 resume/detach/release。拆分方案须重新核对 descriptor、浏览器 PID/创建时间、路径、BuildID、哈希、租约过期与文件挂载原子更新；PID 命名空间默认保持独立，若将来有本地 PID 校验，先划清身份验证的责任，再决定是否共享。RDP 端口留在该命名空间内。

**远程、多客户端。** 当前入口是 stdio；给它加端口映射不会产生 HTTP MCP。只有需要远程连接或多个客户端时，单独引入 MCP Streamable HTTP 入口，明确鉴权、客户端身份、每会话独立 bridge/profile、并发上限和空闲回收。HTTP 暴露的是 MCP，不是 RDP/BiDi。与首版的按需容器在镜像和版本上可以复用，在进程生命周期上分开验收。

## 5. 分阶段验收

| 阶段 | 最小验收 | 失败定位 |
| --- | --- | --- |
| P0：`core` | 两个目标架构构建；真实 MCP 客户端发 `initialize`、`tools/list`、`ruyi_browser_status` 得到 `alive: false` 并确认 Python bridge ready；校验 stdout 仅含协议消息；分别关闭 stdin 与发 SIGTERM 检查退出 | Node/Python 路径、运行层文件、stdio 或信号链 |
| P1：`browser` | 原生架构文件/hash/BuildID 校验；同容器本地 fixture 通过自动化、下载、RDP、Firefox 退出与 profile 回收；并发两个容器验证目录隔离 | ELF 架构、动态库、目录权限、共享内存、容器/Firefox 沙箱 |
| P2：Trace 同会话 | Linux Trace owner 留有有效 descriptor；验收 attach、暂停、恢复、detach、回收 lease、owner flush 和 DOMTrace 输出 | loopback 命名空间、目录共享、owner 状态、内核或 runtime 身份 |

容器化首个 PR 只交付 **P0 的 Dockerfile、`.dockerignore`、构建/启动说明与 CI smoke**，保留浏览器层接口。这样即使 Linux Trace 内核仍在迁移，镜像交付和 stdio 生命周期也能先独立通过验收。
