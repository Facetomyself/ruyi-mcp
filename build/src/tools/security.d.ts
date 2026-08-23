/**
 * Shared security helpers for caller-supplied output paths and proxy display.
 *
 * Path containment rules (used by save_script_source, take_screenshot,
 * set_download_behavior, capture_wait and intercept_wait):
 *
 *   Floor rules (always enforced):
 *     1. path must be absolute (relative paths rejected)
 *     2. no `..` traversal segments
 *     3. no UNC paths (\\host\share or //host/share)
 *     4. no root-level writes (a file/directory sitting directly at a
 *        filesystem root)
 *
 *   Anchor rule (when a workspace root is declared):
 *     - a caller-provided `workspaceRoot`-like argument takes precedence
 *     - otherwise the RUYI_MCP_WORKSPACE_ROOT environment variable
 *     - the resolved path must stay within the declared root
 */
export type PathTargetKind = 'file' | 'directory';
export interface SafePathResult {
    ok: boolean;
    resolved?: string;
    errorCode?: string;
    errorMessage?: string;
}
export declare class SafePathError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Resolve the containment anchor for caller-supplied write paths.
 *
 * Priority: a caller-provided workspaceRoot-like argument, then the
 * RUYI_MCP_WORKSPACE_ROOT environment variable. Returns null when no anchor
 * is declared (the floor rules still apply). Throws SafePathError when a
 * declared anchor is itself invalid (fail closed).
 */
export declare function declaredWriteRoot(args?: Record<string, unknown> | null): string | null;
/**
 * Validate a caller-supplied output path with the shared containment rules.
 *
 * - kind 'file' rejects paths whose parent is a filesystem root (the file
 *   itself would land at the root level).
 * - kind 'directory' rejects paths that are themselves a filesystem root,
 *   while a directory directly below the root (e.g. `D:\downloads`) stays
 *   valid.
 */
export declare function resolveSafeOutputPath(raw: unknown, label: string, kind?: PathTargetKind, anchorRoot?: string | null): SafePathResult;
export interface SafeProxySummary {
    mode: string;
    endpoint?: string;
    credentials: 'none' | 'omitted' | 'external-ref';
}
/**
 * Redact a proxy URL for display: never echo user:pass credentials.
 * Mirrors the Python bridge's _safe_proxy semantics (scheme normalization,
 * host:port endpoint, credentials state) without returning the raw URL.
 */
export declare function safeProxySummary(raw: string | null | undefined): SafeProxySummary;
