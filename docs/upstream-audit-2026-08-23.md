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

## Evaluated and not accepted

These were reviewed after the 1.2.62 package adaptation. They stay out of
`reverse-env/main` until a later audit reopens them with new evidence.

### Firefox 155 as default `RUYI_FIREFOX_PATH` — rejected

Keep `151-proxy`. Do not run `python -m ruyipage install`.

| Evidence | Result |
|----------|--------|
| 1.2.62 installer manifest | `FIREFOX_VERSION=155.0a1`, asset `firefox-155.0a1.en-US.win64-20260803.zip`, SHA-256 `3d4953f4d79b7412ea3abad85414b371e48e6ebc7f3094434cd03832144c50ec` |
| Installer hash verification | Off by default |
| LoseNine/ruyipage#28 | Still open: multithread + Firefox 155 XPCOM crash / memory issues |
| reverse_ENV collector notes | Custom Firefox multi-instance `MOZ_ASSERT` (`0x80000003`) still documented on 151 |
| Local 155 binary | Not installed under `tools/ruyipage/runtimes/` |

A zip at `D:\reverse_ENV\temp\firefox-155.0.en-US.win64.zip` was checked and is
**not** the required kernel:

| Field | Local zip | Required ruyiPage 155 |
|-------|-----------|------------------------|
| Name | `firefox-155.0.en-US.win64.zip` | `firefox-155.0a1.en-US.win64-20260803.zip` |
| SHA-256 | `c942d2a5c16c8dc797a039d2cbdc1291c8efcbcf5d3d8490eded7fc71b1cc3c5` | `3d4953f4d79b7412ea3abad85414b371e48e6ebc7f3094434cd03832144c50ec` |
| Size | 134,644,800 | 133,886,452 |
| Version / BuildID | Mozilla **155.0** / `20260807200632` | LoseNine **155.0a1** fingerprint kernel |
| Vendor / remoting | `Vendor=Mozilla`, `RemotingName=firefox`, Mozilla crash/AUS | Custom fingerprint/proxy kernel |

Official Mozilla 155.0 cannot replace `151-proxy` and cannot be used as the
1.2.62 default runtime. A later 155 candidate must be the LoseNine asset,
extracted to a separate directory, hash-verified, then run through the same
proxy/fingerprint/capture gates.

### Touch MCP tools — rejected

`page.touch` (`tap` / `swipe` / `pinch` / `long_press`) and
`set_touch_fallback` already exist in ruyiPage 1.2.55+. LoseNine/ruyipage#26
is not reporter-confirmed. reverse_ENV has no current H5 touch case. Do not
grow the default automation toolset for this.

### Per-tab proxy MCP tool — rejected

`FirefoxOptions.set_per_tab_proxies()` writes SOCKS5 `host:port:user:pass`
into fpfile and assigns by container `userContextId`. That conflicts with the
Cliproxy sidecar rule: MCP may only receive a verified loopback listener, never
provider credentials. Current collectors use one first hop per browser. A
future design would map already-verified sidecar listeners, not expose
provider userinfo.

### Also out of scope (unchanged)

- Public `Facetomyself/ruyi-mcp` remains `v0.1.7`; no post-0.1.7 capability.
- Python/JS `trace=True` / `ruyi_trace_*` stay deleted on this control plane.
- C++ DOMTrace stays on `ruyitrace-mcp` / Firefox-FingerPrint-Analyzer v2.5.
