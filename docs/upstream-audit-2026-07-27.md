# Upstream adoption audit — 2026-07-27

> Follow-up: the dependency advisory recorded below was resolved by the
> [`2026-07-28` MCP SDK security update](dependency-security-2026-07-28.md)
> and released as `ruyi-mcp 0.1.7`. Browser and Ruyi Trace conclusions in this
> dated audit remain unchanged.

## Scope and evidence path

This audit follows the browser-facing dependencies used around `ruyi-mcp`:

- [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage), the Python/WebDriver BiDi dependency used directly by the MCP bridge;
- [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer), the public distribution entrypoint for the independent Ruyi Trace desktop application and DOMTrace Firefox build.

Discovery was run through the local multi-source search layer, then repository metadata, commits, releases, assets, issues, PRs, and release digests were checked directly with GitHub CLI/API. The release archive and installed runtime were hashed locally, and runtime claims were tested against a local HTTP fixture. Subagents were skipped because the audit had two known upstream repositories and bounded evidence surfaces; parallel searches would have duplicated the same release and issue checks.

This document is a delta from the [`2026-07-18` audit](upstream-audit-2026-07-18.md), not a replacement for its ruyiPage `1.2.50...1.2.54` source and wheel comparison.

## Project snapshot

Metadata is a point-in-time snapshot from 2026-07-27.

| Project | Stars | Forks | Language | License | Latest relevant activity |
|---------|------:|------:|----------|---------|--------------------------|
| [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage) | 1,803 | 205 | Python | BSD-3-Clause | Latest commit remains [`52da4aa`](https://github.com/LoseNine/ruyipage/commit/52da4aa7d1624a414aea0426735320483d9dd535), `release: 1.2.54`, from 2026-07-18 |
| [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer) | 284 | 64 | Release/documentation repository | No repository license metadata | Published [`v2.5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5) on 2026-07-19; the packaged app identifies itself as `2.5.5` |

Neither repository has an upstream PR to adopt. The Ruyi Trace release has an empty release body and the repository still does not publish the Electron or Firefox implementation source, so asset metadata, binary markers, output layout, and runtime fixtures are the available evidence.

## ruyiPage decision

There is no new ruyiPage package or source revision to absorb:

- the exact MCP dependency remains `ruyiPage==1.2.54`;
- the latest browser release remains [`151-ruyi`](https://github.com/LoseNine/ruyipage/releases/tag/151-ruyi);
- the local credentialed-proxy runtime gate remains on the separately downloaded `151-proxy` build;
- there are no commits after `52da4aa` and no PRs.

New issues since the previous audit are triage inputs, not released fixes:

| Evidence | Report | Decision |
|----------|--------|----------|
| [`#24`](https://github.com/LoseNine/ruyipage/issues/24) | The latest fingerprint Firefox build has no Linux package | Record the platform gap. The maintained reverse_ENV runtime gate is Windows-only, so no local contract changes |
| [`#25`](https://github.com/LoseNine/ruyipage/issues/25) | No macOS build; reporter asks for browser source if builds are unavailable | Record the platform and source-availability gap. No published artifact or patch can be adopted |
| [`#26`](https://github.com/LoseNine/ruyipage/issues/26) | Enabling H5 mode reportedly produces no touch-event feedback | Keep open as a future touch-input risk. The current MCP release validates pointer drag/click and native wheel scroll, and the issue has no maintainer confirmation, reproducer, commit, or release |

The MCP package therefore stays at `0.1.6`; this browser audit does not justify a dependency bump or a separate `0.1.7` release.

## Ruyi Trace v2.5 / app 2.5.5

The important upstream delta is the new [`v2.5` release](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v2.5):

| Property | Verified value |
|----------|----------------|
| Asset | [`RuyiTrace-2.5.5-win64.zip`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/download/v2.5/RuyiTrace-2.5.5-win64.zip) |
| Size | `282808599` bytes |
| GitHub/local SHA-256 | `9e7406848c1c55eaa2bd2bcb1abb03643d50b5a09413cdb2c7958fdcd1f6b352` |
| Packaged app version | `2.5.5` |
| Firefox version | `151.0a1` |
| Firefox BuildID | `20260718144531` |
| New `xul.dll` | `205562880` bytes; SHA-256 `15cd08a6c3827a74a012f5c4c805ba7c414c58a510b9dff22883a117625c08d7` |
| Previous local `xul.dll` | `185815040` bytes; SHA-256 `cc8eba8ba07aff948dabac23ce9202633aed798b4b6eb62c20196316b1212600` |

The new kernel restores or adds observable configuration/output surfaces for exception, JSCALL, JSVMP/opcode, WASM, HTTP, WebSocket, full event tracing, runtime gating, and API override behavior. It also changes the output contract from flat `<output>_<PID>.ndjson` shards to module directories such as `domtrace/`, `cookie/`, `storage/`, `event/`, `jscall/`, and `wasm/` below an output anchor.

The reverse_ENV integration adopted the artifact as an independent ignored runtime and added a tracked manifest/verifier. The manifest records the release URL and asset size/digest; the verifier binds Firefox version/BuildID, selected runtime-file digests, the `RUYI_DOMTRACE.txt` build marker, and required ASCII configuration markers. The local archive hash matches GitHub's published digest, and the installed runtime passes the manifest verifier.

## Runtime evidence and limits

The wrapper now creates one `<stem>.modules/<run-id>/` evidence tree per run, merges only `domtrace/trace_process_<PID>.ndjson` into the requested core `-Output`, and preserves all auxiliary module files without mixing incompatible schemas into the core analyzer input. `-SwitchConfig` accepts the GUI-exported `domtrace-switch-config` version 1 schema while the CLI retains authority over the master enable flag, output anchor, run ID, line limit, and process label.

A real local HTTP fixture produced the following evidence:

- 267 core events; strict analyzer result: 0 raw invalid, 0 repaired, and 0 unrecoverable lines;
- Canvas and storage categories were observed in the merged core stream;
- cookie, storage, event, exception, and JSCALL module files were emitted;
- the fixture's `smokeAdd` function produced 44 JSCALL hits;
- the fixture's target exception produced 4 hits.

Evidence boundaries remain explicit:

| Capability | Status |
|------------|--------|
| Core DOMTrace merge and strict parsing | `runtime-verified` |
| cookie / storage / event module production | `runtime-verified` on the local HTTP fixture |
| filtered JSCALL and target exception capture | `runtime-verified` on the local HTTP fixture |
| JSVMP / opcode / WASM | `runtime-pending`; marker/config/output surfaces are not a real target fixture |
| HTTP / WebSocket tracing | `runtime-pending`; no protocol fixture has yet proved payload and lifecycle behavior |

The unchecked modules must not be described as fully reproduced or production-verified merely because the binary contains markers or the GUI exports switches.

## Firefox runtime separation

The two Firefox builds serve different contracts and are not interchangeable:

| Layer | Runtime | Contract |
|-------|---------|----------|
| `ruyi-mcp` / ruyiPage | `151-proxy` locally, with upstream installer still selecting `151-ruyi` | Browser automation, fingerprinting, network capture, human input, and WebDriver BiDi JSON Trace. This is the only runtime used through `RUYI_FIREFOX_PATH` |
| Ruyi Trace CLI | Ruyi Trace 2.5.5 custom Firefox, BuildID `20260718144531` | C++ DOMTrace and auxiliary module output through the independent wrapper |

The Ruyi Trace 2.5.5 browser is not bundled with `ruyi-mcp`, was not validated against the ruyiPage bridge contract, and must not be configured as `RUYI_FIREFOX_PATH`. Conversely, the `151-proxy` runtime has no Ruyi DOMTrace build marker and is not used by the DOMTrace wrapper.

## Validation results

- Clean dependency install: `npm ci` completed from the tracked lockfile.
- MCP offline gate: 27 Bridge contracts passed, including path-free existing-browser attach, detach-only ownership, attach-cache eviction, complete-body capture, native wheel scroll, and click-source reset.
- TypeScript/build gate: typecheck and tracked build passed; stdio smoke exposed 59 tools and the server reports version `0.1.6`.
- ruyiPage runtime gate: the local `151-proxy` Firefox passed window/viewport/screen, fingerprint replay, frame mapping, and atomic-drag checks; the capture fixture passed 20 start/wait/stop cycles with a complete 128 KiB response body.
- DOMTrace tool gate: 19 Python tests passed; the installed 2.5.5 runtime passed its manifest/hash/marker verifier; the 267-event fixture passed strict analysis with zero unrecoverable lines.
- Dependency policy gate: `npm audit --audit-level=high` exited successfully with no high or critical findings. npm still reports two moderate entries for the transitive `@hono/node-server` [`GHSA-frvp-7c67-39w9`](https://github.com/advisories/GHSA-frvp-7c67-39w9); the stdio server does not use Hono `serve-static`, but the upstream dependency finding remains open.

## Adoption result

- Keep `ruyiPage==1.2.54`, 59 MCP tools, and the `0.1.6` package version.
- Keep the MCP runtime gate on `151-proxy` and the upstream installer compatibility statement on `151-ruyi`.
- Adopt Ruyi Trace `v2.5` / app `2.5.5` only in the independent DOMTrace runtime layer.
- Verify the ignored runtime before every use and preserve per-run module evidence.
- Treat JSVMP/opcode/WASM/HTTP/WebSocket as `runtime-pending` until representative fixtures pass.
- Re-audit ruyiPage when a package/commit lands, and re-audit Ruyi Trace when source, release notes, a new digest, or a new platform build appears.
