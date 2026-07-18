# Upstream adoption audit — 2026-07-18

## Scope and evidence path

This audit evaluates whether `ruyi-mcp` should absorb changes from:

- [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage)
- [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer), the public Ruyi Trace distribution entrypoint

Discovery used a multi-source search pass. Repository metadata, commits, tags, releases, Actions, issues, PRs, and recursive trees were then verified directly with GitHub CLI/API. Package claims were checked against downloaded PyPI wheels; runtime claims were checked against the local binaries named below.

## Project snapshot

Metadata is a point-in-time snapshot from 2026-07-18.

| Project | Stars | Forks | Language | License | Activity and fit |
|---------|------:|------:|----------|---------|------------------|
| [`LoseNine/ruyipage`](https://github.com/LoseNine/ruyipage) | 1,707 | 203 | Python | BSD-3-Clause | Active the same day; direct runtime dependency |
| [`LoseNine/Firefox-FingerPrint-Analyzer`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer) | 274 | 63 | Release/documentation repository | No repository license metadata | Latest formal binary release remains v1.2 |

The complete ruyiPage source comparison is [`1.2.50...1.2.54`](https://github.com/LoseNine/ruyipage/compare/3633fc6207561cf09d2bf1df94cb322722d17f92...52da4aa7d1624a414aea0426735320483d9dd535). PyPI wheels for 1.2.50 through 1.2.54 were downloaded, text files were normalized to LF, and the 108 package source/JSON/Markdown files were compared with the mapped Git commits (`.50=3633fc6`, `.51=75e75f2`, `.52=997de72`, `.53=2b332c9`, `.54=52da4aa`); no differences remained. Endpoint hashes were 1.2.50 wheel SHA-256 `22d7d0870d1d12f058f266ac0955ca01fb9a182193b143a9a733f909590198c0` and 1.2.54 wheel SHA-256 `300ef053cdd20c5455338cdd2b34f50d3b049c172c26348d9d39bc7898e3644b`. The latest verified package is [`ruyiPage 1.2.54`](https://pypi.org/project/ruyiPage/1.2.54/).

## ruyiPage decisions

| Evidence | Upstream change | Local decision |
|----------|-----------------|----------------|
| [`75e75f2`](https://github.com/LoseNine/ruyipage/commit/75e75f275e2e19cb22cb3b0393c84a0a04ec7b96) | Startup resize uses the low-level outer-window path | Absorb through the dependency pin |
| [`997de72`](https://github.com/LoseNine/ruyipage/commit/997de72e47e085ec76edb2c8b7324769a4c01d19) | `set_window_size()` becomes outer-only; JS viewport fallback is removed; DPR is no longer applied there | Change the MCP contract: `windowSize` is outer-only, keep `viewport`, add independent `screenSize` |
| [`2fe754a`](https://github.com/LoseNine/ruyipage/commit/2fe754acfd5bd796c680a6841f007717aedf9c75) and [`8f3c72a`](https://github.com/LoseNine/ruyipage/commit/8f3c72a490785425a07d76f712eb67751f49cbd7) | `get_frame(locator)` maps the iframe element's `contentWindow` to its BiDi context and rejects ambiguous URL matches | Add `selector` to the existing `ruyi_select_frame`; keep `contextId` as the stable path and keep the tool count unchanged |
| [`52da4aa`](https://github.com/LoseNine/ruyipage/commit/52da4aa7d1624a414aea0426735320483d9dd535) | Smart fingerprint stops writing `width/height` into fpfile and stops implicit resize. Screen is user-context scoped, while geo/locale/timezone/headers remain browsing-context scoped | Pin 1.2.54; create every fingerprinted tab on `about:blank`. For normal tabs replay context-scoped overlays with `set_screen_size=False`; for containers replay the complete emulation. Then perform the first target navigation and never downgrade a failed container to a normal tab |
| [`52da4aa`](https://github.com/LoseNine/ruyipage/commit/52da4aa7d1624a414aea0426735320483d9dd535) | Action-visual click flushes its move queue | Absorb transitively; no new MCP API because actual drag staging did not change after 1.2.50 |

Relevant issues:

- [`#20`](https://github.com/LoseNine/ruyipage/issues/20): the 1366x768 maximized-window regression motivated screen/outer separation.
- [`#23`](https://github.com/LoseNine/ruyipage/issues/23): the earlier synchronized sizing claim was superseded by the 1.2.52 natural-geometry implementation; code and tests take precedence over the older comment.
- [`#19`](https://github.com/LoseNine/ruyipage/issues/19): remains open for a customized Firefox 128 BiDi serialization problem. It does not establish compatibility for that third-party kernel.

There are no ruyiPage PRs to reuse. Discussions are disabled.

### Upstream validation limitation

The upstream [`1.2.54` Actions run](https://github.com/LoseNine/ruyipage/actions/runs/29629553736) is red across Python 3.9 through 3.13 because the workflow omits the optional `greenlet` dependency during test collection. The same infrastructure defect existed at 1.2.50. It is not evidence of a new 1.2.54 regression, but it also means this integration cannot rely on a green upstream gate.

## Ruyi Trace decisions

The latest formal public release remains [`v1.2`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/releases/tag/v1.2). Its repository tree contains only `.gitignore`, bilingual READMEs, and an icon; the release asset packages the Electron UI and a custom Firefox kernel, but neither implementation is published as source.

| Evidence | Finding | Decision |
|----------|---------|----------|
| [`Issue #4`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/issues/4) | Logs are split by process; strings over 128 KB are truncated in the kernel | Already absorbed locally: stable shard merge, optional shard retention, graceful BiDi close, and strict malformed-line accounting. Kernel truncation cannot be reconstructed safely |
| [`e3d7256`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/commit/e3d7256834e641ee0474e97bfd96ecfca33c9ea3) followed by [`4e4f832`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/commit/4e4f832406acc2fb1b6ff71abe547a40dacaa891) | JSCALL, opcode, JSVMP, WASM, HTTP, and WebSocket environment variables were documented and then fully rolled back as internal-only capability | Reject. The local v1.2 `xul.dll` exposes only the basic `MOZ_DOM_TRACE`, `FILE`, `LIMIT`, and `PTYPE` strings |
| [`Issue #5`](https://github.com/LoseNine/Firefox-FingerPrint-Analyzer/issues/5) | An unconfirmed user report titled “1.3” has no maintainer response, fix commit, PR, or release | Triage-only; do not change the wrapper or claim a v1.3 upgrade |

The visible forks do not contain an ahead or divergent implementation. There is no verified Trace binary or source update to absorb in this cycle.

The local Trace check used `xul.dll` SHA-256 `cc8eba8ba07aff948dabac23ce9202633aed798b4b6eb62c20196316b1212600` and scanned the raw binary for both ASCII and UTF-16LE environment-variable names. The four basic names were present; `MOZ_DOM_JSCALL`, `MOZ_DOM_JSVMP`, `MOZ_DOM_WASM`, `MOZ_DOM_HTTP`, and `MOZ_DOM_WS` were absent.

## Local integration contract

- Pin `ruyiPage==1.2.54` and publish the MCP surface as `v0.1.3`.
- Keep 57 MCP tools and 53 Bridge handlers.
- Preserve the explicit `151-proxy` runtime path; the 1.2.54 installer still selects `151-ruyi`.
- Treat `windowSize`, `viewport`, and `screenSize` as separate operations. Report measured screen/DPR values because the current `151-proxy` runtime applies screen dimensions but may ignore the requested DPR.
- Before first navigation, replay geo/locale/timezone/header overlays on every new tab. Preserve the shared user-context screen on normal tabs and replay screen only for a new container user context.
- Preserve atomic drag and Trace contracts; neither implementation changed upstream after the 1.2.50 baseline.
- Validate offline contracts, TypeScript build, stdio tool schema, dependency audit, and the local `151-proxy` runtime before release.

## Validation results

- Offline Bridge contract: 17 tests passed, covering the exact 1.2.54 pin, proxy auth files, natural outer-window behavior, explicit screen sizing, pre-navigation fingerprint replay, container no-downgrade, navigation cleanup, selector-based frame mapping, atomic drag staging, and Trace lifecycle.
- TypeScript: typecheck and tracked build completed; stdio smoke still exposes 57 tools and now asserts `screenSize` plus `ruyi_select_frame.selector`.
- Dependency gate: `npm audit --audit-level=high` reported 0 vulnerabilities.
- Local runtime: Firefox `151.0a1`, BuildID `20260702113527`, `151-proxy`, headless, and no external network access.
  - outer window `960x640`; Firefox-computed inner viewport `960x554`;
  - explicit screen changed from the host `1366x768` to `1440x900` without changing outer/inner geometry;
  - explicit viewport changed inner geometry to `800x500` and applied DPR `1.25` without changing the user-context screen override;
  - the normal tab's first document observed the inherited `1440x900`; the container's first document observed the pre-navigation replay at `1500x950`;
  - the second of two `srcdoc` frames resolved to value `B` by selector;
  - the drag fixture recorded dozens of pointer moves with the primary button held;
  - requested DPR `1.25` remained actual DPR `1.0` on this runtime, and the Bridge returned `devicePixelRatioApplied: false` with a warning instead of claiming success.

Credentialed HTTP and SOCKS5 behavior did not change upstream after 1.2.50; this cycle reran the offline percent-encoded auth-file contract rather than an external proxy request. Ruyi Trace runtime was not replaced because no newer verified public artifact exists.
