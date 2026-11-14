import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
function endpoint(raw) {
    const value = new URL(raw);
    if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || value.username || value.password || !value.port) {
        throw new Error('Trace control endpoint must be an explicit HTTP loopback port');
    }
    return value;
}
async function readDescriptor(sessionPath) {
    const metadata = await stat(sessionPath);
    if (!metadata.isFile() || metadata.size > 65536)
        throw new Error('Trace descriptor exceeds the 64 KiB limit');
    const content = await readFile(sessionPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 65536)
        throw new Error('Trace descriptor exceeds the 64 KiB limit');
    return JSON.parse(content);
}
export class BorrowedTraceSession {
    sessionPath;
    leaseId;
    descriptor;
    snapshot;
    constructor(sessionPath, descriptor) {
        this.sessionPath = sessionPath;
        this.descriptor = descriptor;
    }
    static async attach(sessionPath) {
        if (!isAbsolute(sessionPath))
            throw new Error('sessionPath must be absolute');
        const descriptor = await readDescriptor(sessionPath);
        BorrowedTraceSession.validate(descriptor);
        const session = new BorrowedTraceSession(sessionPath, descriptor);
        const status = await session.command('status');
        if (status.accepting !== true)
            throw new Error('Trace owner is not accepting control');
        session.validateOwner(status);
        const lease = await session.command('lease.acquire', { seconds: 120 });
        if (typeof lease.leaseId !== 'string' || !lease.leaseId)
            throw new Error('Trace owner did not grant a lease');
        session.leaseId = lease.leaseId;
        return session;
    }
    static validate(descriptor) {
        if (descriptor.schema !== 'ruyitrace-live-session.v1' || !descriptor.runId || !descriptor.bidi?.contextId) {
            throw new Error('Invalid RuyiTrace live-session descriptor');
        }
        if (typeof descriptor.control?.token !== 'string' || descriptor.control.token.length < 16 || !Number.isSafeInteger(descriptor.browser?.pid) || descriptor.browser.pid <= 0 || !descriptor.runtime) {
            throw new Error('Incomplete RuyiTrace live-session descriptor');
        }
        endpoint(descriptor.control.endpoint);
        if (descriptor.expiresAt && Date.parse(descriptor.expiresAt) <= Date.now())
            throw new Error('Trace session descriptor expired');
        if (!['capturing', 'observing'].includes(descriptor.phase))
            throw new Error('Trace owner is no longer active');
        if (!/^[a-f0-9]{64}$/i.test(descriptor.runtime.binarySha256 || '') || !/^\d{14}$/.test(descriptor.runtime.buildId || '') || !descriptor.browser.creationTime || !isAbsolute(descriptor.browser.executablePath)) {
            throw new Error('Trace runtime identity is incomplete');
        }
        if (descriptor.rdp && (descriptor.rdp.host !== '127.0.0.1' || descriptor.rdp.transport !== 'tcp' || !Number.isInteger(descriptor.rdp.port))) {
            throw new Error('Invalid RDP endpoint in trace descriptor');
        }
    }
    async currentDescriptor() {
        const current = await readDescriptor(this.sessionPath);
        BorrowedTraceSession.validate(current);
        if (current.runId !== this.descriptor.runId || current.browser.pid !== this.descriptor.browser.pid || current.browser.creationTime !== this.descriptor.browser.creationTime || current.runtime.binarySha256 !== this.descriptor.runtime.binarySha256 || current.control.endpoint !== this.descriptor.control.endpoint) {
            throw new Error('Trace session identity changed; detach and attach the new descriptor');
        }
        this.descriptor = current;
        return current;
    }
    async command(action, args = {}, timeoutMs = 10000) {
        const current = await this.currentDescriptor();
        const requestId = randomUUID();
        const destination = new URL('/command', endpoint(current.control.endpoint));
        const response = await fetch(destination, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, target: current.bidi.contextId, action, args, timeoutMs, token: current.control.token, leaseId: this.leaseId }),
            signal: AbortSignal.timeout(timeoutMs + 1000),
        });
        if (!response.ok)
            throw new Error(`Trace owner HTTP ${response.status}`);
        const envelope = await response.json();
        if (envelope.requestId !== requestId)
            throw new Error('Trace owner response identity mismatch');
        if (!envelope.ok)
            throw new Error(`Trace owner ${envelope.error?.code || 'COMMAND_FAILED'}: ${envelope.error?.message || 'Command failed'}`);
        if (['navigate', 'click', 'fill', 'press', 'scroll'].includes(action))
            this.snapshot = undefined;
        return envelope.result || {};
    }
    async status() {
        const result = await this.command('status');
        this.validateOwner(result);
        return { alive: result.accepting === true, borrowed: true, owner: 'ruyitrace', runId: this.descriptor.runId, runtime: this.descriptor.runtime, contextId: this.descriptor.bidi.contextId, phase: result.phase, pageCount: 1 };
    }
    validateOwner(status) {
        const runtime = status.runtime;
        const browser = status.browser;
        if (status.runId !== this.descriptor.runId || status.target !== this.descriptor.bidi.contextId || browser?.pid !== this.descriptor.browser.pid || browser?.creationTime !== this.descriptor.browser.creationTime || runtime?.binarySha256 !== this.descriptor.runtime.binarySha256 || runtime?.buildId !== this.descriptor.runtime.buildId) {
            throw new Error('Trace owner identity does not match the descriptor');
        }
    }
    debuggerLease() {
        return { endpoint: this.descriptor.control.endpoint, target: this.descriptor.bidi.contextId, token: this.descriptor.control.token, leaseId: this.leaseId };
    }
    async release() {
        if (!this.leaseId)
            return;
        try {
            await this.command('lease.release', { resumed: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/LEASE_INVALID|LEASE_EXPIRED|no longer active|descriptor expired|Incomplete RuyiTrace/.test(message))
                throw error;
        }
        finally {
            this.leaseId = undefined;
            this.snapshot = undefined;
        }
    }
    async observe(maxNodes = 250) {
        const result = await this.command('query', { selector: 'button,a,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]', maxElements: Math.min(maxNodes, 250) });
        const elements = Array.isArray(result.elements) ? result.elements : [];
        const id = randomUUID();
        this.snapshot = { id, elements, createdAt: Date.now() };
        return { snapshotId: id, borrowed: true, nodes: elements.map((element, index) => ({ index, role: element.tag, name: element.text, value: element.value, visible: element.visible, rect: element.rect })), count: elements.length };
    }
    async act(args) {
        const op = String(args.op);
        if (op === 'DONE' || op === 'BLOCKED')
            return { status: op.toLowerCase(), borrowed: true };
        if (op === 'WAIT')
            return this.command('wait', { milliseconds: args.waitMs ?? 500 });
        if (op === 'SCROLL_UP' || op === 'SCROLL_DOWN')
            return this.command('scroll', { deltaY: op === 'SCROLL_UP' ? -500 : 500 });
        const snapshot = this.snapshot;
        if (!snapshot || args.snapshotId !== snapshot.id || Date.now() - snapshot.createdAt > 30000)
            return { status: 'miss', reason: 'snapshot-stale', retried: false };
        const element = snapshot.elements[Number(args.index)];
        if (!element || typeof element.selector !== 'string')
            return { status: 'miss', reason: 'node-unavailable', retried: false };
        const checked = await this.command('query', { selector: element.selector, maxElements: 2 });
        const current = Array.isArray(checked.elements) ? checked.elements : [];
        if (current.length !== 1 || current[0].tag !== element.tag || current[0].text !== element.text || current[0].visible !== true)
            return { status: 'miss', reason: 'node-changed', retried: false };
        if (op === 'CLICK')
            return this.command('click', { selector: element.selector });
        if (op === 'TYPE_TEXT')
            return this.command('fill', { selector: element.selector, text: args.text ?? '' });
        return { status: 'miss', reason: 'unsupported-borrowed-action', retried: false };
    }
}
//# sourceMappingURL=borrowed-session.js.map