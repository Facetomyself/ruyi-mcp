# Dependency security follow-up — 2026-07-28

## Trigger

The `2026-07-27` upstream audit recorded the moderate
[`GHSA-frvp-7c67-39w9`](https://github.com/advisories/GHSA-frvp-7c67-39w9)
finding in the transitive `@hono/node-server` dependency. The stdio-only MCP
server does not call Hono `serve-static`, but the dependency finding remained
open in the installed production tree.

## Upstream resolution

- [`@modelcontextprotocol/sdk 1.30.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0)
  was published on 2026-07-27.
- The upstream fix in
  [`modelcontextprotocol/typescript-sdk#2549`](https://github.com/modelcontextprotocol/typescript-sdk/pull/2549)
  permits `@hono/node-server ^1.19.9 || ^2.0.5`.
- This release resolves to `@modelcontextprotocol/sdk 1.30.0` and
  `@hono/node-server 2.0.12` from the tracked lockfile. Hono 2.x requires
  Node.js 20 or later, which matches this repository's existing engine floor.

## Adoption decision

- Raise the explicit MCP SDK baseline to `^1.30.0` and release `ruyi-mcp 0.1.7`.
- Keep the stdio transport, 59-tool surface, Bridge protocol, and
  `ruyiPage==1.2.54` compatibility baseline unchanged.
- Do not add an override or retain an advisory exception.
- Track MCP TypeScript SDK v2 as a separate migration because it changes
  package layout and compatibility surfaces beyond this security update.

## Validation

- Clean lockfile install completed with 96 installed packages.
- TypeScript typecheck, Python syntax checks, all 27 Bridge contracts, tracked
  build, and the 59-tool stdio smoke passed.
- The local `151-proxy` runtime gate passed window/viewport/screen,
  fingerprint replay, frame mapping, and atomic drag checks. The capture gate
  passed 20 start/wait/stop cycles with complete 128 KiB bodies.
- `npm audit --omit=dev` reported zero vulnerabilities.
