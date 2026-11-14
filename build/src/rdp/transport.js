import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
export class RdpError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RdpError';
    }
}
const EVENTS = new Set([
    'paused', 'resumed', 'newSource', 'tabListChanged', 'workerListChanged',
    'serviceWorkerRegistrationListChanged', 'processListChanged', 'addonListChanged',
    'target-available-form', 'target-destroyed-form', 'descriptor-destroyed',
    'resources-available-array', 'resources-updated-array', 'resources-destroyed-array',
    'frameUpdate', 'tabNavigated', 'willNavigate', 'navigate', 'documentEvent',
    'consoleAPICall', 'pageError', 'networkEvent', 'networkEventUpdate', 'evaluationResult',
    'newMutations', 'root-available', 'root-destroyed', 'newRoot', 'pickerNodeHovered',
    'pickerNodePicked', 'pickerNodePreviewed', 'pickerNodeCanceled', 'eventNotification',
]);
function looksLikeUnknownEvent(packet) {
    const type = typeof packet.type === 'string' ? packet.type : '';
    return /(?:event|notification|changed|available|destroyed|created|paused|resumed|navigate|mutation|target|source|frame|resource)/iu.test(type);
}
export class RdpTransport extends EventEmitter {
    epoch = randomUUID();
    socket;
    buffer = Buffer.alloc(0);
    pending = new Map();
    queues = new Map();
    failure;
    greeting;
    get connected() { return Boolean(this.socket && !this.failure && !this.socket.destroyed); }
    async open(host, port, timeoutMs = 10_000) {
        if (!['127.0.0.1', '::1', 'localhost'].includes(host))
            throw new RdpError('ENDPOINT_INVALID', 'RDP must use loopback');
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new RdpError('ENDPOINT_INVALID', 'Invalid RDP port');
        if (this.socket || this.failure)
            throw new RdpError('SESSION_EXPIRED', 'Create a fresh transport for each connection');
        const greeting = new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.close(new RdpError('RDP_TIMEOUT', 'RDP greeting timed out')), timeoutMs);
            this.pending.set('root', { resolve, reject, timer });
        });
        this.socket = connect({ host, port });
        this.socket.setNoDelay(true);
        this.socket.on('data', chunk => this.receive(chunk));
        this.socket.on('error', error => this.close(new RdpError('RDP_DISCONNECTED', error.message)));
        this.socket.on('close', () => this.close(new RdpError('RDP_DISCONNECTED', 'RDP socket closed')));
        this.greeting = await greeting;
        return this.greeting;
    }
    request(actor, type, params = {}, timeoutMs = 10_000) {
        const previous = this.queues.get(actor) ?? Promise.resolve();
        const operation = previous.catch(() => { }).then(() => this.exchange(actor, type, params, timeoutMs));
        this.queues.set(actor, operation);
        void operation.finally(() => {
            if (this.queues.get(actor) === operation)
                this.queues.delete(actor);
        }).catch(() => { });
        return operation;
    }
    exchange(actor, type, params, timeoutMs) {
        if (!this.connected)
            return Promise.reject(this.failure ?? new RdpError('RDP_DISCONNECTED', 'RDP is not connected'));
        if (!actor || !type || !Number.isFinite(timeoutMs) || timeoutMs < 1)
            return Promise.reject(new RdpError('INVALID_ARGUMENT', 'Invalid RDP request'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.close(new RdpError('RDP_TIMEOUT', `${type} timed out; session invalidated`)), timeoutMs);
            this.pending.set(actor, { resolve, reject, timer });
            const body = Buffer.from(JSON.stringify({ ...params, to: actor, type }), 'utf8');
            this.socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]), error => {
                if (error)
                    this.close(new RdpError('RDP_DISCONNECTED', error.message));
            });
        });
    }
    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length) {
            const separator = this.buffer.indexOf(58);
            if (separator < 0) {
                if (this.buffer.length > 24)
                    this.close(new RdpError('RDP_PROTOCOL', 'Invalid frame header'));
                return;
            }
            const header = this.buffer.subarray(0, separator).toString('ascii');
            if (!/^\d{1,10}$/.test(header)) {
                this.close(new RdpError('RDP_PROTOCOL', 'Invalid frame header'));
                return;
            }
            const length = Number(header);
            if (length > 64 * 1024 * 1024) {
                this.close(new RdpError('RDP_LIMIT', 'RDP packet exceeds 64 MiB'));
                return;
            }
            if (this.buffer.length < separator + 1 + length)
                return;
            const body = this.buffer.subarray(separator + 1, separator + 1 + length);
            this.buffer = this.buffer.subarray(separator + 1 + length);
            let packet;
            try {
                packet = JSON.parse(body.toString('utf8'));
            }
            catch {
                this.close(new RdpError('RDP_PROTOCOL', 'Malformed JSON frame'));
                return;
            }
            if (!packet || Array.isArray(packet) || typeof packet !== 'object' || typeof packet.from !== 'string') {
                this.close(new RdpError('RDP_PROTOCOL', 'RDP packet must be an object with an actor'));
                return;
            }
            if (EVENTS.has(packet.type)) {
                this.emit('event', packet);
                continue;
            }
            const pending = this.pending.get(packet.from);
            if (!pending) {
                this.emit('notification', packet);
                continue;
            }
            if (looksLikeUnknownEvent(packet)) {
                this.emit('notification', packet);
                continue;
            }
            clearTimeout(pending.timer);
            this.pending.delete(packet.from);
            if (packet.error)
                pending.reject(new RdpError(String(packet.error), String(packet.message ?? packet.error), packet));
            else
                pending.resolve(packet);
        }
    }
    close(reason = new RdpError('SESSION_CLOSED', 'RDP session closed')) {
        if (this.failure)
            return;
        this.failure = reason;
        this.socket?.destroy();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(reason);
        }
        this.pending.clear();
        this.buffer = Buffer.alloc(0);
        this.emit('closed', reason);
    }
}
//# sourceMappingURL=transport.js.map