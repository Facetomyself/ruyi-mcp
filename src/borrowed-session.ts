import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TraceSessionDescriptor {
  schema: string;
  runId: string;
  caseId?: string;
  phase: string;
  expiresAt?: string;
  runtime: { name?: string; version?: string; buildId?: string; binarySha256?: string; firefoxVersion?: string };
  browser: { pid: number; creationTime?: string; executablePath: string; profilePath?: string };
  bidi: { contextId: string };
  rdp: { host: string; port: number; transport: string; browserId?: number; browsingContextId?: string | number } | null;
  control: { endpoint: string; token: string };
}

function endpoint(raw: string): URL {
  const value = new URL(raw);
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || value.username || value.password || !value.port) {
    throw new Error('Trace control endpoint must be an explicit HTTP loopback port');
  }
  return value;
}

async function readDescriptor(sessionPath: string): Promise<TraceSessionDescriptor> {
  const metadata = await stat(sessionPath);
  if (!metadata.isFile() || metadata.size > 65536) throw new Error('Trace descriptor exceeds the 64 KiB limit');
  const content = await readFile(sessionPath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > 65536) throw new Error('Trace descriptor exceeds the 64 KiB limit');
  return JSON.parse(content) as TraceSessionDescriptor;
}

export class BorrowedTraceSession {
  private leaseId: string | undefined;
  private descriptor: TraceSessionDescriptor;
  private snapshot: { id: string; elements: Array<Record<string, unknown>>; createdAt: number } | undefined;

  private constructor(readonly sessionPath: string, descriptor: TraceSessionDescriptor) {
    this.descriptor = descriptor;
  }

  static async attach(sessionPath: string): Promise<BorrowedTraceSession> {
    if (!isAbsolute(sessionPath)) throw new Error('sessionPath must be absolute');
    const descriptor = await readDescriptor(sessionPath);
    BorrowedTraceSession.validate(descriptor);
    const session = new BorrowedTraceSession(sessionPath, descriptor);
    const status = await session.command('status');
    if (status.accepting !== true) throw new Error('Trace owner is not accepting control');
    session.validateOwner(status);
    const lease = await session.command('lease.acquire', { seconds: 120 });
    if (typeof lease.leaseId !== 'string' || !lease.leaseId) throw new Error('Trace owner did not grant a lease');
    session.leaseId = lease.leaseId;
    return session;
  }

  private static validate(descriptor: TraceSessionDescriptor): void {
    if (descriptor.schema !== 'ruyitrace-live-session.v1' || !descriptor.runId || !descriptor.bidi?.contextId) {
      throw new Error('Invalid RuyiTrace live-session descriptor');
    }
    if (typeof descriptor.control?.token !== 'string' || descriptor.control.token.length < 16 || !Number.isSafeInteger(descriptor.browser?.pid) || descriptor.browser.pid <= 0 || !descriptor.runtime) {
      throw new Error('Incomplete RuyiTrace live-session descriptor');
    }
    endpoint(descriptor.control.endpoint);
    if (descriptor.expiresAt && Date.parse(descriptor.expiresAt) <= Date.now()) throw new Error('Trace session descriptor expired');
    if (!['capturing', 'observing'].includes(descriptor.phase)) throw new Error('Trace owner is no longer active');
    if (!/^[a-f0-9]{64}$/i.test(descriptor.runtime.binarySha256 || '') || !/^\d{14}$/.test(descriptor.runtime.buildId || '') || !descriptor.browser.creationTime || !isAbsolute(descriptor.browser.executablePath)) {
      throw new Error('Trace runtime identity is incomplete');
    }
    if (descriptor.rdp && (descriptor.rdp.host !== '127.0.0.1' || descriptor.rdp.transport !== 'tcp' || !Number.isInteger(descriptor.rdp.port))) {
      throw new Error('Invalid RDP endpoint in trace descriptor');
    }
  }

  async currentDescriptor(): Promise<TraceSessionDescriptor> {
    const current = await readDescriptor(this.sessionPath);
    BorrowedTraceSession.validate(current);
    const previous = this.descriptor;
    if (current.runId !== previous.runId || current.browser.pid !== previous.browser.pid ||
        current.browser.creationTime !== previous.browser.creationTime || current.browser.executablePath !== previous.browser.executablePath ||
        current.runtime.binarySha256 !== previous.runtime.binarySha256 || current.runtime.buildId !== previous.runtime.buildId ||
        current.bidi.contextId !== previous.bidi.contextId || current.control.endpoint !== previous.control.endpoint ||
        current.control.token !== previous.control.token || current.rdp?.host !== previous.rdp?.host ||
        current.rdp?.port !== previous.rdp?.port || current.rdp?.transport !== previous.rdp?.transport ||
        current.rdp?.browserId !== previous.rdp?.browserId || current.rdp?.browsingContextId !== previous.rdp?.browsingContextId) {
      throw new Error('Trace session identity changed; detach and attach the new descriptor');
    }
    this.descriptor = current;
    return current;
  }

  async command(action: string, args: Record<string, unknown> = {}, timeoutMs = 10000): Promise<Record<string, unknown>> {
    const current = await this.currentDescriptor();
    const requestId = randomUUID();
    const destination = new URL('/command', endpoint(current.control.endpoint));
    const response = await fetch(destination, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, target: current.bidi.contextId, action, args, timeoutMs, token: current.control.token, leaseId: this.leaseId }),
      signal: AbortSignal.timeout(timeoutMs + 1000),
    });
    if (!response.ok) throw new Error(`Trace owner HTTP ${response.status}`);
    const envelope = await response.json() as { requestId: string; ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } };
    if (envelope.requestId !== requestId) throw new Error('Trace owner response identity mismatch');
    if (!envelope.ok) throw new Error(`Trace owner ${envelope.error?.code || 'COMMAND_FAILED'}: ${envelope.error?.message || 'Command failed'}`);
    if (['navigate', 'click', 'fill', 'press', 'scroll'].includes(action)) this.snapshot = undefined;
    return envelope.result || {};
  }

  async status(): Promise<Record<string, unknown>> {
    const result = await this.command('status');
    this.validateOwner(result);
    return { alive: result.accepting === true, borrowed: true, owner: 'ruyitrace', runId: this.descriptor.runId, runtime: this.descriptor.runtime, contextId: this.descriptor.bidi.contextId, phase: result.phase, pageCount: 1 };
  }

  private validateOwner(status: Record<string, unknown>): void {
    const runtime = status.runtime as TraceSessionDescriptor['runtime'] | undefined;
    const browser = status.browser as TraceSessionDescriptor['browser'] | undefined;
    if (status.runId !== this.descriptor.runId || status.target !== this.descriptor.bidi.contextId || browser?.pid !== this.descriptor.browser.pid || browser?.creationTime !== this.descriptor.browser.creationTime || runtime?.binarySha256 !== this.descriptor.runtime.binarySha256 || runtime?.buildId !== this.descriptor.runtime.buildId) {
      throw new Error('Trace owner identity does not match the descriptor');
    }
  }

  debuggerLease(): { endpoint: string; target: string; token: string; leaseId?: string } {
    return { endpoint: this.descriptor.control.endpoint, target: this.descriptor.bidi.contextId, token: this.descriptor.control.token, leaseId: this.leaseId };
  }

  async release(): Promise<void> {
    if (!this.leaseId) return;
    try {
      await this.command('lease.release', { resumed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/LEASE_INVALID|LEASE_EXPIRED|no longer active|descriptor expired|Incomplete RuyiTrace/.test(message)) throw error;
    } finally {
      this.leaseId = undefined;
      this.snapshot = undefined;
    }
  }

  async observe(maxNodes = 250): Promise<Record<string, unknown>> {
    const result = await this.command('query', { selector: 'button,a,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]', maxElements: Math.min(maxNodes, 250) });
    const elements = Array.isArray(result.elements) ? result.elements as Array<Record<string, unknown>> : [];
    const id = randomUUID();
    this.snapshot = { id, elements, createdAt: Date.now() };
    return { snapshotId: id, borrowed: true, nodes: elements.map((element, index) => ({ index, role: element.tag, name: element.text, value: element.value, visible: element.visible, rect: element.rect })), count: elements.length };
  }

  async act(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = String(args.op);
    if (op === 'DONE' || op === 'BLOCKED') return { status: op.toLowerCase(), borrowed: true };
    if (op === 'WAIT') return this.command('wait', { milliseconds: args.waitMs ?? 500 });
    if (op === 'SCROLL_UP' || op === 'SCROLL_DOWN') return this.command('scroll', { deltaY: op === 'SCROLL_UP' ? -500 : 500 });
    const snapshot = this.snapshot;
    if (!snapshot || args.snapshotId !== snapshot.id || Date.now() - snapshot.createdAt > 30000) return { status: 'miss', reason: 'snapshot-stale', retried: false };
    const element = snapshot.elements[Number(args.index)];
    if (!element || typeof element.selector !== 'string') return { status: 'miss', reason: 'node-unavailable', retried: false };
    const checked = await this.command('query', { selector: element.selector, maxElements: 2 });
    const current = Array.isArray(checked.elements) ? checked.elements as Array<Record<string, unknown>> : [];
    if (current.length !== 1 || current[0].tag !== element.tag || current[0].text !== element.text || current[0].visible !== true) return { status: 'miss', reason: 'node-changed', retried: false };
    if (op === 'CLICK') return this.command('click', { selector: element.selector });
    if (op === 'TYPE_TEXT') return this.command('fill', { selector: element.selector, text: args.text ?? '' });
    return { status: 'miss', reason: 'unsupported-borrowed-action', retried: false };
  }
}
