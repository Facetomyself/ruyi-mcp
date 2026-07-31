# Upstream adoption audit — 2026-07-30

## Executive decision

Decision: **ADOPT PACKAGE / KEEP DEFAULT RUNTIME**.

- Adopt `ruyiPage==1.2.56` as `ruyi-mcp 0.1.8` on the dedicated adaptation branch while keeping the locally verified `151-proxy` Firefox runtime as the default.
- Preserve the public screen/viewport contract by never forwarding `screenSize.devicePixelRatio`; keep the compatibility input but return `devicePixelRatioApplied: false` and direct callers to `viewport.devicePixelRatio`.
- Keep accepting `screenOrientation.angle` for older clients, but report it as explicitly ignored because ruyiPage 1.2.56 no longer sends the field.
- Do not land `1.2.55` as an intermediate release. Its touch work remains outside the current 59-tool MCP surface and `1.2.56` supersedes it.
- Do not replace `151-proxy` with Firefox 155. Firefox 155 passed the full interaction gate but failed before capture cycle 0 because it requires `-remote-allow-system-access` for the bridge's `page.url` path.
- Keep MCP TypeScript SDK v2 migration separate under [`ruyi-mcp#7`](https://github.com/Facetomyself/ruyi-mcp/issues/7).

The initial real-Firefox probe proved that a direct dependency bump was unsafe. The implemented adapter now preserves the contract, and the complete mandatory package, lifecycle, capture, attach/detach, and current-runtime gates are green.

## Scope and evidence path

This is a delta audit from [`2026-07-27`](upstream-audit-2026-07-27.md). It covers:

- [`Facetomyself/ruyi-mcp`](https://github.com/Facetomyself/ruyi-mcp), the direct Git source of this submodule;
- [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage), the Python/WebDriver BiDi API and browser-runtime source used by the bridge;
- [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer), the independent Ruyi Trace/DOMTrace distribution surface.

Discovery began with the local `search-layer` in deep/status mode. Exa and Tavily completed; Grok fallback returned HTTP 503. Search results were treated only as leads. Repository metadata, commits, tags, releases, assets, issues, PRs, Actions, security advisories, and source trees were then checked directly with GitHub CLI/API. PyPI wheels were downloaded with the project venv, hashed, extracted, and compared with the corresponding Git trees after LF normalization.

Three read-only subagents were used and deduplicated by the controller:

| Agent | Scope | Main contribution |
|-------|-------|-------------------|
| `local_baseline` | Local Git/submodule/version/test baseline | Confirmed `v0.1.7`, clean subrepo, exact gitlink, pins, and private-API coupling |
| `github_surface` | Releases, commits, issues, PRs, Actions, assets | Found `1.2.55`, `1.2.56`, Firefox 155, the changed 151 release assets, and the missing `151-proxy` release |
| `compat_risk` | Source/contract/runtime risk review | Identified screen, orientation, capture, lifecycle, SDK, and rollback risks |

The controller directly rechecked the strongest claims with GitHub API, wheel/source comparison, isolated contract runs, and the local `151-proxy` Firefox runtime.

Direct `git fetch origin` could not connect to `github.com:443`; cached refs alone were therefore not trusted. GitHub API independently confirmed that remote `Facetomyself/ruyi-mcp` main is still `66314a3`.

## Repository relationship and snapshot

Metadata was first captured on 2026-07-30 and rechecked through GitHub API at 2026-07-31 00:19:52 +08:00.

| Project | Stars | Forks | Language | License | Relationship and current state |
|---------|------:|------:|----------|---------|--------------------------------|
| [`Facetomyself/ruyi-mcp`](https://github.com/Facetomyself/ruyi-mcp) | 14 | 3 | Python | MIT | Direct Git source; not a fork; latest is [`v0.1.7 / 66314a3`](https://github.com/Facetomyself/ruyi-mcp/commit/66314a3d5523cb7ebbf47ecf619d3d05c6aaee69), exactly matching local HEAD |
| [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage) | 1,812 | 205 | Python | BSD-3-Clause | Actual browser API/runtime source; advanced from 1.2.54 to 1.2.56 and published new Firefox assets |
| [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer) | 284 | 64 | Release/documentation repository | No repository license metadata | Independent DOMTrace distribution; still v2.5/app 2.5.5, with no post-2026-07-27 delta |

`ruyi-mcp` is a community integration, not a Git fork of `ruyipage`. There is no upstream branch to merge. Adoption means changing the exact PyPI dependency and adapting the local bridge contract.

## Pre-adoption local baseline

- The adaptation branch started from subrepo HEAD and parent gitlink `66314a3d5523cb7ebbf47ecf619d3d05c6aaee69`, exact tag `v0.1.7`.
- Direct remote main, verified through GitHub API: the same `66314a3`.
- Python dependency before adaptation: `ruyiPage==1.2.54`; the branch and project venv now use exact `1.2.56`.
- Node dependency: `@modelcontextprotocol/sdk 1.30.0`.
- Pre-adaptation contract surface: 59 MCP tools and 27 offline Bridge tests; the adopted branch has 59 tools, a complete schema snapshot, and 35 Bridge tests.
- Verified browser: `D:\reverse_ENV\tools\ruyipage\runtimes\151-proxy\firefox\firefox.exe`.
- Local runtime identity: Firefox `151.0a1`, BuildID `20260702113527`; documented release-asset SHA-256 `f82151f9f197b528b36fb461cf106bc6825c0f752efb5c5d762c34f7529055f6`; current `firefox.exe` SHA-256 `4a7aecf0b57d6cf7f5ef2c1df27f0462070d369929290abd286fb9678f05e0bc`.

The parent repository already had unrelated dirty changes before this audit. They were not modified or normalized.

## Upstream package delta

### ruyiPage 1.2.55

[`f0dc116`](https://github.com/LoseNine/ruyipage/commit/f0dc11651c799baea1ebf7647a825291824bc061), published 2026-07-28, adds H5 touch support and addresses [`Issue #26`](https://github.com/LoseNine/ruyipage/issues/26):

- structured `set_touch_enabled_result()` status;
- trusted touch actions;
- startup fpfile fallback for older Firefox builds;
- touch capability tests.

The maintainer reports `pointerType=touch`, `touchstart`/`touchend`, and `isTrusted=true` in [the issue comment](https://github.com/LoseNine/ruyipage/issues/26#issuecomment-5106827850). The reporter has not confirmed the fix and the issue remains open. The current MCP does not expose a touch tool, so this is useful future capability rather than an urgent production fix.

### ruyiPage 1.2.56

[`c130ea1`](https://github.com/LoseNine/ruyipage/commit/c130ea16a2b14cd9ceb59bc52acd528b3797235e), published 2026-07-30, is a 24-file `BiDi protocol alignment` change with approximately 2,653 additions and 408 deletions. It includes:

- updated BiDi payloads for screen, viewport, CSP, screencast, session, preload scripts, data collection, and download behavior;
- owned-process-tree cleanup on failed startup and force quit while preserving `existing_only` detach behavior;
- optional high-density profile preferences;
- touch work equivalent to the 1.2.55 package code;
- protocol conformance tests based on a dummy driver.

The `v1.2.55` and `v1.2.56` tags are sibling commits based on `1.2.54`. Main then merged them at [`7c79f7d`](https://github.com/LoseNine/ruyipage/commit/7c79f7dfe7ae837782083b8df7251d5d5bb7fe71); the merge adds the 1.2.55 README section on top of 1.2.56 code. The PyPI 1.2.56 package maps to tag `c130ea1`, not the later merge commit.

The commit also carries target-specific JavaScript verification fixtures unrelated to the Python package runtime. They are excluded from the wheel but increase review noise. There was no PR, review discussion, or package release note.

## Wheel/source verification

Wheels were downloaded without dependencies and inspected outside the installed project environment.

| Package | Wheel SHA-256 | Source mapping |
|---------|---------------|----------------|
| `ruyiPage 1.2.55` | `10d610d58e0fa976fd4b92e031ba1c5a0ea62390eace7fe22d3273b8b8e70306` | 108 package files match tag `f0dc116` after LF normalization; `_fingerprint/README.md` is source-only |
| `ruyiPage 1.2.56` | `ee4fde2d41a0c4a11dbeceb13d94af9280580a0ea56d3ced0d3c8f8c67984ff8` | 108 package files match tag `c130ea1` after LF normalization; `_fingerprint/README.md` is source-only |

The 1.2.56 wheel contains CRLF in 79 package files while the Git tree uses LF. Raw Git-blob hashes therefore differ for those files, but all mismatches disappear after the same LF normalization used by earlier audits. The functional source delta from 1.2.55 to 1.2.56 is limited to ten package files.

## Issue, PR, and advisory scan

### Facetomyself/ruyi-mcp

- Remote main and latest release remain `v0.1.7 / 66314a3`; no local Git update is required.
- Open PRs: 0.
- Only open issue: [`#7 — Evaluate MCP TypeScript SDK v2 migration`](https://github.com/Facetomyself/ruyi-mcp/issues/7). It is intentionally independent from the browser dependency update.
- Latest CI for `v0.1.7` is green: [run 30320543166](https://github.com/Facetomyself/ruyi-mcp/actions/runs/30320543166).

### LoseNine/ruyipage

- Issues: 4 open, 22 closed.
- PRs: 0 across the repository history.
- Public GitHub security advisories: 0.
- Open issues relevant to this audit:
  - [`#26`](https://github.com/LoseNine/ruyipage/issues/26): touch fix in 1.2.55, not yet reporter-confirmed;
  - [`#25`](https://github.com/LoseNine/ruyipage/issues/25): no macOS build/source gap, no patch or artifact;
  - [`#24`](https://github.com/LoseNine/ruyipage/issues/24): no current Linux browser build; Firefox 155 remains Windows-only;
  - [`#19`](https://github.com/LoseNine/ruyipage/issues/19): third-party Firefox 128 BiDi serialization divergence, not applicable to the current `151-proxy` runtime.

Previously absorbed window, frame, drag, attach, and capture issues have no new post-2026-07-27 evidence.

### Firefox-FingerPrint-Analyzer

- No commit, release, issue, or PR delta after 2026-07-27.
- Issues: 2 open, 3 closed; PRs: 0; public GitHub security advisories: 0.
- The current decision remains: no Ruyi Trace adoption change.

Zero public advisories only describes the GitHub advisory surface; it is not a binary security audit.

## Verified compatibility results

The pre-adaptation probes in this table used the project Python venv, isolated extracted wheel trees, and the existing local Firefox runtime. At that stage they did not change the installed `ruyiPage==1.2.54` package; the project venv was upgraded only after the mandatory adapted gates passed.

| Probe | Result | Interpretation |
|-------|--------|----------------|
| Current 27 offline Bridge contracts against isolated 1.2.55 | 27/27 passed | Existing private imports and offline behaviors remain compatible |
| Current 27 offline Bridge contracts against isolated 1.2.56 | 27/27 passed | Necessary but insufficient; the fake page does not observe upstream BiDi side effects |
| Full `runtime_ruyipage_1254.py` gate against 1.2.55 + `151-proxy` | Passed | 1.2.55 preserves the current window/screen/viewport/frame/drag baseline |
| Full runtime gate against 1.2.56 + `151-proxy` | Failed | `screenSize(1440x900, DPR 1.25)` changed inner viewport from `960x554` to `1440x900` |
| `runtime_capture_lifecycle.py`, 1.2.56 + `151-proxy`, 20 cycles | Passed | Every cycle returned `[302, 200]`, complete 128 KiB body, bounded stop; new collector schema works on this runtime |
| Process cleanup after runtime probes | Passed | No Firefox process remained |

The capture schema is no longer a demonstrated blocker on the current runtime, but its payload should still be locked with a new offline contract because the upstream implementation changed substantially.

### Reproduced screen/viewport regression

With the same dummy BiDi driver, the two versions emit different calls:

```text
1.2.55:
  emulation.setScreenSettingsOverride(
    screenArea=1440x900,
    devicePixelRatio=1.25,
    contexts=[ctx-1]
  )

1.2.56:
  emulation.setScreenSettingsOverride(
    screenArea=1440x900,
    contexts=[ctx-1]
  )
  browsingContext.setViewport(
    context=ctx-1,
    viewport=1440x900,
    devicePixelRatio=1.25
  )
```

The full Firefox probe confirms that this is not merely a payload diff. The current MCP deliberately treats `windowSize`, `viewport`, and `screenSize` as independent controls. Passing `screenSize.devicePixelRatio` through unchanged to 1.2.56 violates that public contract.

### Orientation semantic change

The MCP schema still accepts `screenOrientation.angle`, and the Bridge passes it to `page.set_screen_orientation()`. In 1.2.56, the Python method still accepts `angle`, but the lower-level BiDi payload no longer includes it. A direct bump would silently claim an input that is ignored.

### Upstream CI limitation

The latest ruyiPage [Actions run 30510171796](https://github.com/LoseNine/ruyipage/actions/runs/30510171796) is red for Windows Python 3.9 through 3.13. Every job fails during test collection because the workflow omits optional `greenlet`; fast, browser, integration, and release gates are skipped. This is an existing workflow defect rather than proof of a 1.2.56 regression, but it leaves the release without an upstream green gate.

## Implemented adaptation and final gates

The adaptation was implemented and published on `chore/ruyipage-1.2.56-adaptation`. MCP configuration and the default runtime remain unchanged; the parent gitlink is updated separately and only after the referenced subrepo commit is available on the remote branch.

| Gate | Result | Evidence |
|------|--------|----------|
| Exact wheel/tag identity | Passed | Wheel SHA-256 `ee4fde2d41a0c4a11dbeceb13d94af9280580a0ea56d3ced0d3c8f8c67984ff8`; annotated tag `v1.2.56` resolves to `c130ea1`; 108 wheel payload files match after LF normalization with one documented source-only packaging exclusion |
| Offline Bridge contracts | 35/35 passed | Exact pin, screen/viewport separation, observed orientation-type postcondition plus ignored angle, current DataCollector payload, process-tree ownership, capture normalization, attach ownership, action, frame, trace, stdin EOF, and explicit shutdown |
| TypeScript/build/tool surface | Passed | Typecheck, Python compile, tracked build, 59-tool stdio smoke, and complete canonical schema snapshot |
| Server/Bridge lifecycle | Passed | Registry isolation, child-stdin EPIPE, stale-child/restart generation isolation, active-bridge stdin EOF, stdout EPIPE, and idempotent cleanup; 5 passed and the real SIGTERM race case was skipped on Windows by design |
| Current `151-proxy` full runtime | Passed | Natural inner `960x554` stayed unchanged after screen `1440x900`; viewport `800x500` with DPR `1.25`; orientation type observed as `portrait-primary` while angle `90` remained ignored; frame `B`; drag; click count 1; three trusted native wheel events and `scrollY=270`; normal/container first-navigation fingerprint replay |
| Current `151-proxy` capture | Passed | 20/20 cycles returned `[302, 200]`, preserved the complete 128 KiB body, and completed bounded cleanup |
| Current `151-proxy` attach/detach | Passed | The same caller-owned Firefox process survived two attach/detach cycles, retained the page marker, and was terminated only by the original owner during test cleanup |
| Process cleanup | Passed | No Firefox process remained after any mandatory runtime probe |

The final default-runtime full/capture/attach evidence is stored at `D:\reverse_ENV\storage\ruyipage\browser-matrix\151-proxy-current\runtime-gate.json`; `storage/` remains outside Git.

The Server registry is now instance-local rather than module-global. Server close, stdin EOF, transport close, EPIPE, and signal paths share one cleanup promise; Python stdin EOF and explicit `__shutdown__` also converge on one browser-aware cleanup path. The tool count remains 59, and touch exposure remains a separate future feature.

## Browser asset and reproducibility audit

### Current `151-proxy`

The previously documented `https://github.com/LoseNine/ruyipage/releases/tag/151-proxy` release now returns 404 through both `gh` and the REST release endpoint. The lightweight tag and commit [`7f23562`](https://github.com/LoseNine/ruyipage/commit/7f23562ae71560e18c5c402ae6232d0886af8474) remain, but the public release asset cannot be reconstructed from release metadata.

The extracted local runtime is still healthy, but no matching archive was found under `storage/`. It is now a rollback asset and must be backed up before any browser experiment.

### Side-by-side browser matrix

All public candidates were downloaded to separate storage directories, hashed, extracted without touching the working runtime, and run through the same 1.2.56 full/capture gates.

| Candidate | BuildID | Archive SHA-256 | Full gate | 20-cycle capture | Decision |
|-----------|---------|----------------|-----------|------------------|----------|
| Current preserved `151-proxy` | `20260702113527` | local deterministic rollback archive `876d9df2f5a605d9c14811d7fdd68232ae5634623d6121bf006c6211d19cf53a` | Passed | Passed | Keep default; only verified proxy-capable baseline |
| `151-ruyi` undated installer asset | `20260530120704` | `8a724622bef11d7d1049a5e9fb8d8fedd8ec987eaa65d2ec2a6ca8cac0a65f77` | Passed | Passed | Compatible fallback candidate; proxy capability not established |
| `151-ruyi` dated `20260729` | `20260718144531` | `2fca3ff3fdb12289ccfc57e3ce66b6a1ecfa6fcd106903cfa54a4d2c2b4a1131` | Passed | Passed | Compatible candidate; proxy capability not established |
| Firefox `155` dated `20260730` | `20260729175533` | `e3bd331ab6635d555f90b1a92df503b47564fdb61b64dab081a693036d05953b` | Passed | Failed before cycle 0 | Block default: bridge launch requires `-remote-allow-system-access` |

The 1.2.56 package installer still selects release `151-ruyi` and the old undated `firefox-151.0a1.en-US.win64.zip`. Both Firefox 151 public assets are package-compatible under the tested non-proxy gates, but neither proves credentialed HTTP/SOCKS5 or fingerprint equivalence with `151-proxy`.

## Adoption matrix

| Surface | Decision | Reason |
|---------|----------|--------|
| `Facetomyself/ruyi-mcp` Git main | No update | Local HEAD already equals verified remote main |
| `ruyiPage 1.2.55` | Do not release separately | Full runtime-compatible, but superseded and touch is not in the current MCP surface |
| `ruyiPage 1.2.56` | Adopt as `ruyi-mcp 0.1.8` | Adapter preserves screen/viewport separation, reports ignored angle/DPR explicitly, and all mandatory gates pass |
| Current `151-proxy` | Keep default and preserve | Only fully verified proxy-capable runtime; public release asset is no longer retrievable |
| Undated and dated `151-ruyi` | Compatible side-by-side candidates | Full/capture gates pass, but proxy and fingerprint equivalence remain unproved |
| Firefox 155 | Block default | Full interaction gate passes; capture bridge launch fails without `-remote-allow-system-access` |
| Ruyi Trace v2.5 | No change | No new source, release, issue resolution, or PR |
| MCP SDK v2 | Separate workstream | Tracked by `ruyi-mcp#7`; do not combine protocol, browser, and server migrations |

## Shortest safe implementation plan

Status: Phases 0 through 4 and the package-side portion of Phase 5 are complete. The adaptation implementation was committed as `c1d391e` and pushed to `origin/chore/ruyipage-1.2.56-adaptation`; merge/release and the separate parent gitlink update remain independent follow-up operations.

### Phase 0 — preserve rollback evidence

1. Archive the existing `151-proxy` runtime into a new immutable `storage/ruyipage/151-proxy/` location without replacing the working copy.
2. Record archive hash, extracted tree identity, `firefox.exe` hash, Firefox version/BuildID, original release/tag URL, and the current 404 state in a manifest.
3. Re-run a launch/quit smoke from the working runtime after archival. Do not switch `.mcp.json` or `.codex/config.toml`.

### Phase 1 — create an isolated package adaptation branch

1. Start from `ruyi-mcp` commit `66314a3`; do not reuse the gone/stale 1.2.54 feature branches.
2. Create a branch such as `chore/ruyipage-1.2.56-adaptation`.
3. Pin the candidate only inside the branch/isolated environment and record wheel SHA-256 plus tag `c130ea1` parity.

### Phase 2 — preserve the public MCP contract

1. For `screenSize`, call upstream 1.2.56 without `device_pixel_ratio` so screen dimensions cannot implicitly rewrite viewport dimensions. Keep the input field for compatibility, but return an explicit `devicePixelRatioApplied: false`/warning unless a separate viewport operation is requested and verified.
2. For `screenOrientation.angle`, either remove/deprecate it in a versioned contract or keep accepting it while returning an explicit ignored/unsupported warning. Do not report silent success.
3. Add an offline payload regression for the new `network.addDataCollector` schema and preserve the current complete-body, single/list normalization, and bounded cleanup behavior.
4. Preserve existing-browser detach-only ownership and add a failed-startup/force-quit regression around the upstream process-tree cleanup.
5. Keep the MCP tool count at 59. Touch exposure, if wanted, belongs in a later feature change with its own trusted-event fixture.

### Phase 3 — required package/runtime gates

Run, in order:

1. exact version pin and wheel/source parity;
2. updated offline Bridge contracts;
3. TypeScript typecheck, Python syntax, tracked build consistency, and 59-tool stdio schema snapshot;
4. full window/outer/viewport/screen/DPR separation gate on `151-proxy`;
5. frame mapping, atomic drag, click reset, wheel scroll, fingerprint replay, and attach-survival gates;
6. 20-cycle capture with redirect chain, complete 128 KiB body, and bounded stop;
7. dependency audit and Claude/Codex cold-start checks.

Any semantic regression would have blocked the pin and left production at 1.2.54. The mandatory gates passed; the Firefox 155-only capture failure blocks that browser candidate, not the 1.2.56 package on the preserved default runtime.

### Phase 4 — browser matrix, never in-place

Extract each candidate to a distinct runtime directory and record its own manifest:

1. current `151-proxy` — mandatory compatibility and rollback baseline;
2. old installer `151-ruyi` — installer baseline;
3. dated `151-ruyi` asset — candidate comparison;
4. Firefox 155 — candidate comparison.

Run the same package/runtime gates for each. Do not infer proxy support, fingerprint behavior, or DOMTrace capability from the Firefox version string.

### Phase 5 — release and rollback

Only after all mandatory gates pass:

1. release `ruyi-mcp 0.1.8` with `ruyiPage==1.2.56`;
2. update bilingual README compatibility text, runtime docs, audit links, and tracked build;
3. publish the subrepo commit first, then update the parent gitlink to that remotely reachable commit in a separate, reviewable parent commit; merge/release remains a repository-maintainer decision;
4. keep `151-proxy` as default unless a candidate browser separately proves every required capability.

Rollback is the exact previous dependency pin and gitlink. Because the default runtime is not changed during the package adaptation, browser rollback remains immediate.

## Remaining limits

- Firefox 155 remains blocked for the current capture bridge because system-context evaluation requires `-remote-allow-system-access`; adding that launch capability needs a separate security/compatibility decision and regression gate.
- The two public Firefox 151 candidates passed non-proxy gates, but credentialed HTTP/SOCKS5, fingerprint, and DOMTrace equivalence with the preserved `151-proxy` runtime remain unproved.
- Project CI still covers only Ubuntu, Node.js 20, and Python 3.13; Windows and minimum/current runtime version matrices remain follow-up hardening rather than evidence supplied by upstream CI.
- Initial Git transport to `github.com:443` timed out, while GitHub CLI/API continued to verify remote refs and evidence surfaces. A later retry published the dedicated adaptation branch successfully.
- The published adaptation branch, exact dependency pin, local project venv, tool schema, and tracked build now target 1.2.56/0.1.8. No MCP config or default runtime path changed. Parent gitlink maintenance follows the subrepo-first publication order; merge and release have not been performed.
