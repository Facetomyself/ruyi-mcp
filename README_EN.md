# ruyi-mcp

[简体中文](README.md) | [English](README_EN.md)

One maintained Firefox automation and native debugging MCP. Automation uses ruyiPage / WebDriver BiDi; debugging uses this repository's TypeScript RDP adapter. Public and local deployments share the same implementation and version. This is an independent community integration, not an official ruyiPage project.

## Setup

Requirements: Node.js 20+, Python 3.10+, and `ruyiPage==1.2.68`. The initial unified runtime target is RuyiTrace 3.5.0 Firefox159, BuildID `20261101193257`. Other builds require their own capability and runtime checks; historical Firefox151 results are not Firefox159 verification.

```bash
git clone https://github.com/Facetomyself/ruyi-mcp.git
cd ruyi-mcp
npm ci
python -m pip install -r requirements.txt
npm run check
```

Configure your MCP host to execute `node /absolute/path/to/ruyi-mcp/build/src/index.js`. Set `RUYI_MCP_PYTHON`, `RUYI_FIREFOX_PATH`, `RUYI_MCP_PROFILE_ROOT`, and `RUYI_MCP_TOOLSET=compact`. Do not let the ruyiPage installer silently replace the pinned Firefox build. Runtime binaries, profiles, credentials, and captured data are not distributed in this repository.

The [`linux` branch](https://github.com/Facetomyself/ruyi-mcp/tree/linux) maintains the complete project in the same repository. See the [Linux port notes](docs/linux-port.md) for standalone setup, verification, and runtime prerequisites, and the [Docker design](docs/docker-design.md) for proposed images, stdio deployment, and release gates (Chinese).

## Tools and behavior

- Automation retains pages, DOM, precise frames, cookies, humanized input, proxy/fingerprint configuration, capture/interception, WebSockets, downloads, session handoff, and observe/act.
- Native debugging covers sources, possible breakpoint locations, conditions, logpoints, stepping, run-to, synchronous frame restart, stacks, closures, paused evaluation, object properties, exceptions, request/event/DOM breakpoints, and blackboxing.
- Source maps and top-level/frame/dedicated/shared/service-worker targets are verified per runtime. Registered tools alone do not prove runtime support.
- WASM support covers binary export and JS boundaries, not instruction stepping or DWARF.

`compact` exposes five resident tools: `ruyi_browser_status`, `ruyi_observe`, `ruyi_act`, `ruyi_search_tools`, and `ruyi_execute_tool`. Search returns schemas on demand; execution validates the target schema and invokes the same registered handler. Other toolsets filter discovery only. `all` exposes the complete registry.

Starting the MCP does not start Firefox. Reserving a loopback RDP endpoint, attaching, and arming pauses are separate operations. Attach begins in observe mode; first-execution breakpoints require watcher configuration before navigation or worker creation. Targets bind to explicit identities, never a first matching URL.

Shared-worker target forms may omit the URL. `ruyi_debug_enable` then requires exact `sharedWorkerUrls`; the adapter revalidates the attached thread's real source URLs and rejects mismatches instead of adopting another same-origin worker.

The default pause budget is 30 seconds. Frames and object grips belong to a session epoch and pause ID; expired handles are rejected. Timeout invalidates the RDP connection so a late response cannot answer another request. The resume channel is independent of the Python automation bridge.

Native debugging does not inject `debugger;` or wrap page XHR/fetch. This reduces those page modifications, but does not guarantee invisibility, zero overhead, or superiority over native CDP. Explicit automation scripts and preload tools remain separate capabilities.

Unsupported native combinations are reported explicitly: worker outbound XHR/fetch request breakpoints, worker DOM mutation breakpoints, and async/generator frame restart. Service-worker fetch-handler source breakpoints remain distinct from outbound request breakpoints.

## Borrowed Trace sessions

Discover the Trace-session tools and supply the absolute path to the owner's private descriptor at `<run>/control/session.json`. Keep its authentication material private. The Trace worker remains the only BiDi and browser-lifecycle owner; automation uses its bounded navigate/query/click/fill/press/scroll/wait/screenshot interface, while RDP handles pause and resume independently.

Use the exact `descriptorPath` reported by the Trace CLI. MCP requests a 120-second exclusive lease. In borrowed mode, `ruyi_browser_status.controlAvailable` reports control separately from owner liveness. `leaseState: "revoked"` is terminal for that attachment; `"unknown"` means the owner has not confirmed the lease. `observe` and `act` accept only page 0 and the published top-level BiDi context; a mismatched scope returns `UNSUPPORTED_SCOPE` before contacting the owner. Snapshots are specific to the run and context. Borrowed `quit` returns `effect: "lease_released"` only on owner acknowledgement, or `"lease_already_lost"` on confirmed loss; `browserDisposition: "retained_by_owner"` describes ownership, not a fresh liveness probe. Unconfirmed release failures are retryable. Run `npm run build && npm run check:borrowed-behaviors` for the stdio contract tests.

If the descriptor goes missing, an attached client reports `publicationState: "missing"` and `controlAvailable: false`. Without proof of exit, the browser state is `"unknown"` and `quit` returns `ENOENT`, keeping the original lease available for retry. On Linux, when MCP verifies the original run’s private final receipts in the same user and PID namespace and both original process generations have exited, status reports `alive: false`, `browserState: "exited"`, and `leaseState: "revoked"`. Old page operations then return `OWNER_RETIRED`, and `quit` clears the local attachment with `lease_already_lost` so the same client can attach to a new run. Restarting MCP discards the local attachment; only an owner acknowledgement proves release.

## Compatibility and data

`ruyi_bidi_trace_start/stop/get_results` provide a browser-wide BiDi command/event timeline. Legacy `ruyi_trace_*` names are deprecated aliases, never C++ RuyiTrace. Capture and interception default to metadata; body data goes to an explicitly requested JSONL file rather than inline responses.

Session export requires `caseId` and `workspaceRoot`. Cookie values remain in evidence files referenced by size and hash. Storage snapshots do not imply import support. Caller-owned profiles and externally attached browsers are not deleted or terminated.

See [the unified migration guide](docs/unified-0.4.md). Compatibility field names such as `publicBaseSha`, `localHeadSha`, and the parent's `privateControlPlane` no longer identify separate product editions.

## Validation and maintenance

`npm run check` runs compilation, Python contracts, tool schemas, lifecycle tests, RDP transport tests, and source-map tests without starting Firefox. Configure the runtime and run `check:rdp-runtime`, `check:rdp-intervention`, `check:runtime`, `check:capture-runtime`, `check:attach-runtime`, `check:download-runtime`, and `check:agent-runtime` against local fixtures. Unified release acceptance additionally covers owner IPC and lease/stop/flush.

The canonical repository is `Facetomyself/ruyi-mcp`. Public and former integration history are retained; the old private mirror becomes a migration pointer after the unified release passes its gates. Parent repositories pin a published, verified commit. Historical audit documents apply only to their original builds.

MIT. See [LICENSE](LICENSE).
