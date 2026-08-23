# Upstream adoption audit — 2026-08-23

## Executive decision

Decision: **ADOPT PACKAGE / KEEP DEFAULT RUNTIME**.

- Adopt `ruyiPage==1.2.62` as `ruyi-mcp 0.2.0-reverse-env.2`.
- Keep the locally verified `151-proxy` Firefox as the default `RUYI_FIREFOX_PATH`.
- Do not run `python -m ruyipage install`. The 1.2.62 installer manifest points at Firefox 155 (`v1.2.58` assets) and hash verification is off by default.
- Force `allow_system_access(False)` on owned launches. This process is often elevated on Windows; upstream would otherwise add `--remote-allow-system-access`.
- Non-private owned launches start on `about:blank` so BiDi overlays work without privileged system access.
- Capture global-scope fallback lands with the package (1.2.62); the Bridge does not reimplement it.
- Default MCP toolset is `automation`. Soft-breakpoint and source tools require `RUYI_MCP_TOOLSET=all`.
- C++ DOMTrace / Python `trace=True` remain out of this control plane.

## Upstream delta (1.2.56 → 1.2.62)

PyPI 1.2.62 wheel SHA-256: `56beef8a87ce749c6843f306b746a7842785683d2fa7ecc0de7dbdcd46fcd4a7`.

Git compare `v1.2.56...v1.2.62`: 21 commits, 15 package files changed.

| Version | Why it matters |
|---------|----------------|
| 1.2.57 | `action_visual` preload is session-scoped and not DevTools. Protected URLs read via BiDi metadata. |
| 1.2.58 | `launch()` uses script-accessible `about:blank` without system-access. |
| 1.2.59 | Smart fingerprint: real Firefox major UA, independent Canvas/Audio seeds, IANA timezone, `GeolocationProfile`. |
| 1.2.60 | Async argument unwrap at the sync boundary. |
| 1.2.61 | Installer default runtime becomes Firefox 155. |
| 1.2.62 | Capture collector/subscribe falls back to global scope on privileged-scope errors. |

## Runtime matrix

| Candidate | Status |
|-----------|--------|
| Local `151-proxy` | Default. Passed 2026-08-23: window/frame/drag/click/scroll runtime gate, 20-cycle capture `[302, 200]`, attach survival, native download. |
| Upstream Firefox 155 | Parallel candidate only. Issue `#28` (XPCOM / multithread crash) is still open. reverse_ENV collector notes still document 151 multi-instance `MOZ_ASSERT`. |
| Ruyi Trace 2.5.5 | Independent evidence plane. Not `RUYI_FIREFOX_PATH`. No post-2026-07-19 capability delta. |

## Not absorbed

- Public `Facetomyself/ruyi-mcp` still `v0.1.7`.
- `page.touch` MCP tool: no current H5 case.
- `set_per_tab_proxies` MCP tool: Cliproxy sidecar remains launch-time first hop.
- Python/JS trace and C++ DOMTrace.
