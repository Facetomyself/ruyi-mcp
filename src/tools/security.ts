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

import { isAbsolute, parse, relative, resolve } from 'node:path';

export type PathTargetKind = 'file' | 'directory';

export interface SafePathResult {
  ok: boolean;
  resolved?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class SafePathError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SafePathError';
  }
}

const TRAVERSAL_SEGMENT = '..';

function pathHasTraversalSegment(raw: string): boolean {
  return raw.split(/[\\/]+/).includes(TRAVERSAL_SEGMENT);
}

function isUncRoot(parsedRoot: string): boolean {
  return parsedRoot.startsWith('\\\\') || parsedRoot.startsWith('//');
}

function validateDeclaredRoot(raw: string, label: string): string {
  const parsed = parse(raw);
  if (!isAbsolute(raw)) {
    throw new SafePathError('INVALID_ANCHOR', `${label} must be an absolute path`);
  }
  if (isUncRoot(parsed.root)) {
    throw new SafePathError('INVALID_ANCHOR', `${label} must not be a UNC path`);
  }
  if (pathHasTraversalSegment(raw)) {
    throw new SafePathError('INVALID_ANCHOR', `${label} must not contain '..' segments`);
  }
  return resolve(raw);
}

/**
 * Resolve the containment anchor for caller-supplied write paths.
 *
 * Priority: a caller-provided workspaceRoot-like argument, then the
 * RUYI_MCP_WORKSPACE_ROOT environment variable. Returns null when no anchor
 * is declared (the floor rules still apply). Throws SafePathError when a
 * declared anchor is itself invalid (fail closed).
 */
export function declaredWriteRoot(args?: Record<string, unknown> | null): string | null {
  const fromArgs = args?.workspaceRoot;
  if (typeof fromArgs === 'string' && fromArgs.trim()) {
    return validateDeclaredRoot(fromArgs, 'workspaceRoot');
  }
  const fromEnv = process.env.RUYI_MCP_WORKSPACE_ROOT;
  if (fromEnv && fromEnv.trim()) {
    return validateDeclaredRoot(fromEnv, 'RUYI_MCP_WORKSPACE_ROOT');
  }
  return null;
}

/**
 * Validate a caller-supplied output path with the shared containment rules.
 *
 * - kind 'file' rejects paths whose parent is a filesystem root (the file
 *   itself would land at the root level).
 * - kind 'directory' rejects paths that are themselves a filesystem root,
 *   while a directory directly below the root (e.g. `D:\downloads`) stays
 *   valid.
 */
export function resolveSafeOutputPath(
  raw: unknown,
  label: string,
  kind: PathTargetKind = 'file',
  anchorRoot?: string | null
): SafePathResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      ok: false,
      errorCode: 'INVALID_PATH',
      errorMessage: `${label} must be a non-empty string`,
    };
  }
  const candidate = raw.trim();
  if (!isAbsolute(candidate)) {
    return {
      ok: false,
      errorCode: 'RELATIVE_PATH',
      errorMessage: `${label} must be an absolute path`,
    };
  }
  const parsed = parse(candidate);
  if (isUncRoot(parsed.root)) {
    return {
      ok: false,
      errorCode: 'UNC_PATH',
      errorMessage: `${label} must not be a UNC path`,
    };
  }
  if (pathHasTraversalSegment(candidate)) {
    return {
      ok: false,
      errorCode: 'TRAVERSAL',
      errorMessage: `${label} must not contain '..' path segments`,
    };
  }
  const remainder = candidate.slice(parsed.root.length);
  if (!remainder) {
    return {
      ok: false,
      errorCode: 'ROOT_WRITE',
      errorMessage: `${label} must not target a filesystem root`,
    };
  }
  if (kind === 'file' && !/[/\\]/.test(remainder)) {
    return {
      ok: false,
      errorCode: 'ROOT_WRITE',
      errorMessage: `${label} must not write a file directly at a filesystem root`,
    };
  }
  const resolvedPath = resolve(candidate);
  if (anchorRoot) {
    const rel = relative(anchorRoot, resolvedPath);
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!inside) {
      return {
        ok: false,
        errorCode: 'OUTSIDE_ANCHOR',
        errorMessage: `${label} must stay within the declared workspace root`,
      };
    }
  }
  return { ok: true, resolved: resolvedPath };
}

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
export function safeProxySummary(raw: string | null | undefined): SafeProxySummary {
  const value = (raw ?? '').trim();
  if (!value) {
    return { mode: 'direct', credentials: 'none' };
  }
  if (value.toLowerCase() === 'system') {
    return { mode: 'system', credentials: 'external-ref' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { mode: 'unknown', credentials: 'omitted' };
  }
  let scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'socks5h' || scheme === 'socks') {
    scheme = 'socks5';
  }
  if (!['http', 'https', 'socks5'].includes(scheme) || !parsed.hostname) {
    return { mode: 'unknown', credentials: 'omitted' };
  }
  const endpoint = parsed.hostname + (parsed.port ? `:${parsed.port}` : '');
  return {
    mode: scheme,
    endpoint,
    credentials: parsed.username || parsed.password ? 'omitted' : 'none',
  };
}
