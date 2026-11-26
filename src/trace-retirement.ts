import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readFile, readlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { TraceSessionDescriptor } from './borrowed-session.js';

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

// Trace's Linux CLI writes a schema-2 result before atomically publishing the
// final state with that result embedded. Only enable the fallback for a run we
// have independently bound while its authenticated publication was live.
const receiptLimit = 4 * 1024 * 1024;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const regularFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const generation = /^[1-9]\d{0,19}$/;
type ProcessIdentity = { pid: number; startTime: string };
export type PinnedTraceRun = {
  out: string; uid: bigint; bootId: string; pidNamespace: string;
  run: FileHandle; runStat: BigIntStats; control: FileHandle; controlStat: BigIntStats;
  owner: ProcessIdentity; browser: ProcessIdentity; descriptor: TraceSessionDescriptor;
};

const fdPath = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const privateMode = (st: BigIntStats, uid: bigint) => st.uid === uid && (st.mode & 0o077n) === 0n;
const stableFile = (a: BigIntStats, b: BigIntStats) => sameInode(a, b) && a.mode === b.mode && a.uid === b.uid &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function openDirectory(path: string): Promise<FileHandle> {
  let current = await open('/', directoryFlags);
  try {
    for (const name of path.split('/').filter(Boolean)) {
      const next = await open(fdPath(current, name), directoryFlags);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if (hasCode(error, 'ENOENT')) return true; throw error; }
}

async function readPrivateJSON(dir: FileHandle, name: string, parent: BigIntStats, uid: bigint, limit: number) {
  const path = fdPath(dir, name);
  const file = await open(path, regularFlags);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || !privateMode(before, uid) || before.dev !== parent.dev || before.nlink !== 1n || before.size > BigInt(limit)) {
      throw new Error('Invalid private Trace publication');
    }
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== Number(before.size) || !stableFile(before, await file.stat({ bigint: true })) ||
        !stableFile(before, await lstat(path, { bigint: true }))) throw new Error('Trace publication changed during read');
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))) as unknown, stamp: before };
  } finally { await file.close(); }
}

function processIdentity(value: unknown): ProcessIdentity | undefined {
  const entry = record(value);
  const pid = entry?.pid, startTime = entry?.startTime;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff &&
      typeof startTime === 'string' && generation.test(startTime)) return { pid, startTime };
}

async function linuxProcess(pid: number): Promise<{ state: string; startTime: string } | undefined> {
  let text: string;
  try { text = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ESRCH')) return; throw error; }
  const end = text.lastIndexOf(')');
  const tail = text.slice(end + 1).trim().split(/\s+/);
  if (end < 0 || !text.startsWith(`${pid} (`) || !/^[A-Za-z]$/.test(tail[0]) || !generation.test(tail[19])) {
    throw new Error('Invalid Linux process identity');
  }
  return { state: tail[0], startTime: tail[19] };
}

async function liveGeneration(identity: ProcessIdentity): Promise<boolean> {
  const process = await linuxProcess(identity.pid);
  return !!process && process.startTime === identity.startTime && !['Z', 'X', 'x'].includes(process.state);
}

async function sameLinuxNamespace(bootId: string, pidNamespace: string): Promise<boolean> {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === bootId &&
    await readlink('/proc/self/ns/pid') === pidNamespace;
}

function matchesRun(state: Record<string, unknown>, run: Pick<PinnedTraceRun, 'out' | 'bootId' | 'pidNamespace' | 'descriptor' | 'browser'>, sessionPath: string): boolean {
  const { out, bootId, pidNamespace, descriptor, browser } = run;
  const mcp = record(state.mcp), runtime = record(state.runtime);
  const digests = record(runtime?.executable_digests);
  const executable = basename(descriptor.browser.executablePath);
  return state.schema === 2 && state.out === out && state.runId === descriptor.runId && state.bootId === bootId &&
    state.pidNamespace === pidNamespace && state.profile === descriptor.browser.profilePath &&
    isDeepStrictEqual(processIdentity(state.browser), browser) && mcp?.descriptorPath === sessionPath &&
    mcp?.contextId === descriptor.bidi.contextId && runtime?.build_id === descriptor.runtime.buildId &&
    (executable === 'firefox' || executable === 'firefox-bin') && digests?.[executable] === descriptor.runtime.binarySha256;
}

async function stillBound(run: PinnedTraceRun, allowRemovedControl: boolean): Promise<boolean> {
  const current = await openDirectory(run.out);
  try {
    const st = await current.stat({ bigint: true });
    if (!sameInode(st, run.runStat) || !privateMode(st, run.uid)) return false;
    try {
      const control = await lstat(fdPath(current, 'control'), { bigint: true });
      return control.isDirectory() && sameInode(control, run.controlStat) && privateMode(control, run.uid);
    } catch (error) {
      if (allowRemovedControl && hasCode(error, 'ENOENT')) return true;
      throw error;
    }
  } finally { await current.close(); }
}

async function closePinned(run?: FileHandle, control?: FileHandle): Promise<void> {
  await Promise.allSettled([run?.close(), control?.close()]);
}

export async function closePinnedTraceRun(run: PinnedTraceRun): Promise<void> {
  await closePinned(run.run, run.control);
}

export async function pinTraceRun(sessionPath: string, descriptor: TraceSessionDescriptor): Promise<PinnedTraceRun | undefined> {
  if (process.platform !== 'linux' || !process.geteuid || resolve(sessionPath) !== sessionPath ||
      typeof descriptor.runId !== 'string' || !uuid.test(descriptor.runId) || descriptor.runtime.name !== 'RuyiTrace' ||
      typeof descriptor.browser.creationTime !== 'string') return;
  const out = dirname(dirname(sessionPath));
  if (out === '/' || sessionPath !== join(out, 'control', 'session.json') ||
      descriptor.browser.profilePath !== join(out, 'profile')) return;
  const [, bootId, startTime, extra] = (descriptor.browser.creationTime ?? '').split(':');
  if (!descriptor.browser.creationTime?.startsWith('linux:') || extra !== undefined || !uuid.test(bootId) || !generation.test(startTime)) return;
  const browser = processIdentity({ pid: descriptor.browser.pid, startTime });
  if (!browser) return;
  const uid = BigInt(process.geteuid());
  let run: FileHandle | undefined, control: FileHandle | undefined, pinned = false;
  try {
    run = await openDirectory(out);
    const runStat = await run.stat({ bigint: true });
    if (!privateMode(runStat, uid)) return;
    control = await open(fdPath(run, 'control'), directoryFlags);
    const controlStat = await control.stat({ bigint: true });
    if (!privateMode(controlStat, uid) || controlStat.dev !== runStat.dev) return;
    const publication = await readPrivateJSON(control, 'session.json', controlStat, uid, 65536);
    if (!isDeepStrictEqual(descriptor, publication.value)) return;
    const active = await readPrivateJSON(run, 'state.json', runStat, uid, receiptLimit);
    const state = record(active.value), owner = processIdentity(state?.owner), pidNamespace = state?.pidNamespace;
    if (!state || !owner || owner.pid === browser.pid || typeof pidNamespace !== 'string' || !/^pid:\[\d+\]$/.test(pidNamespace)) return;
    const binding = { out, uid, bootId, pidNamespace, run, runStat, control, controlStat, owner, browser, descriptor };
    if (state.phase !== 'running' || state.ready !== true || state.result !== undefined || !matchesRun(state, binding, sessionPath) ||
        !await sameLinuxNamespace(bootId, pidNamespace) || !await liveGeneration(owner) ||
        await readlink(`/proc/${browser.pid}/exe`) !== descriptor.browser.executablePath || !await liveGeneration(browser) ||
        !await absent(fdPath(run, 'result.json')) || !await stillBound(binding, false) ||
        !stableFile(publication.stamp, await lstat(fdPath(control, 'session.json'), { bigint: true }))) return;
    pinned = true;
    return binding;
  } catch { /* Optional proof; older / non-production attachments stay supported. */ }
  finally { if (!pinned) await closePinned(run, control); }
}

function failedWithRevocation(result: Record<string, unknown>, run: PinnedTraceRun): boolean {
  const browser = record(result.browser), mcp = record(result.mcp);
  const validExit = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 255;
  const abnormalBrowserExit = (validExit(browser?.code) && browser?.signal === null) ||
    (browser?.code === null && typeof browser.signal === 'string' && Object.hasOwn(osConstants.signals, browser.signal));
  const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const acquired = mcp?.leasesAcquired, released = mcp?.leasesReleased, expired = mcp?.leasesExpired, revoked = mcp?.leasesRevoked;
  // The run-wide totals corroborate retirement; they are not an ACK or a
  // claim about how this specific lease ID was counted by the owner.
  return result.schema === 2 && result.out === run.out && result.runId === run.descriptor.runId &&
    result.passed === false && validExit(result.exit) && result.completion === 'browser-exit' && abnormalBrowserExit &&
    validCount(acquired) && validCount(released) && validCount(expired) && validCount(revoked) &&
    revoked > 0 && acquired === released + expired + revoked;
}

export async function proveTraceRetirement(run: PinnedTraceRun, sessionPath: string): Promise<boolean> {
  try {
    const statePath = fdPath(run.run, 'state.json'), resultPath = fdPath(run.run, 'result.json');
    const final = await readPrivateJSON(run.run, 'state.json', run.runStat, run.uid, receiptLimit);
    const state = record(final.value);
    if (!state || state.phase !== 'failed' || !matchesRun(state, run, sessionPath) ||
        !isDeepStrictEqual(processIdentity(state.owner), run.owner)) return false;
    const receipt = await readPrivateJSON(run.run, 'result.json', run.runStat, run.uid, receiptLimit);
    const result = record(receipt.value);
    if (!result || !failedWithRevocation(result, run) || !isDeepStrictEqual(state.result, result)) return false;
    // A matching zombie/dead entry has already exited; unreadable or malformed
    // /proc entries throw and leave retirement unconfirmed.
    return await sameLinuxNamespace(run.bootId, run.pidNamespace) &&
      !await liveGeneration(run.owner) && !await liveGeneration(run.browser) &&
      await stillBound(run, true) && await absent(fdPath(run.control, 'session.json')) &&
      stableFile(final.stamp, await lstat(statePath, { bigint: true })) &&
      stableFile(receipt.stamp, await lstat(resultPath, { bigint: true }));
  } catch { return false; }
}
