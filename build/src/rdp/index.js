import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { RdpTransport, RdpError } from './transport.js';
import { AsyncSourceMaps } from './map-client.js';
function integer(value, fallback, minimum, maximum) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < minimum || result > maximum)
        throw new RdpError('INVALID_ARGUMENT', `Expected integer in ${minimum}..${maximum}`);
    return result;
}
function actorOf(value) {
    if (typeof value === 'string')
        return value;
    return value && typeof value === 'object' ? String(value.actor ?? '') : '';
}
function bounded(value, depth = 0) {
    if (depth > 8)
        return { truncated: true };
    if (typeof value === 'string')
        return value.length > 8192 ? `${value.slice(0, 8192)}…` : value;
    if (Array.isArray(value))
        return value.slice(0, 100).map(entry => bounded(entry, depth + 1));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).slice(0, 150).map(([key, item]) => [key, bounded(item, depth + 1)]));
    return value;
}
export class NativeDebuggerManager extends EventEmitter {
    getSession;
    transport;
    descriptor;
    tabDescriptor;
    watcher;
    sharedWatcher;
    sharedBreakpointActor;
    sharedConfigurationActor;
    watcherTraits = {};
    breakpointActor;
    configurationActor;
    targets = new Map();
    sourceOwners = new Map();
    breakpoints = new Map();
    selected;
    preferredTopTarget;
    preferredContextId;
    preferredTopInnerWindowId;
    allowedInnerWindowIds = new Set();
    sharedWorkerUrls = new Set();
    targetTasks = new Set();
    mode = 'observe';
    watchdogSeconds = 30;
    sequence = 0;
    maps = new AsyncSourceMaps();
    logs = [];
    leaseTimer;
    ownsLease = false;
    closing;
    attachPromise;
    sessionOptions = {};
    configuration = {};
    observedOperations = new Set();
    evaluationWaiters = new Map();
    evaluationResults = new Map();
    constructor(getSession) {
        super();
        this.getSession = getSession;
    }
    connection() {
        if (!this.transport?.connected)
            throw new RdpError('DEBUGGER_NOT_ATTACHED', 'Attach the native debugger first');
        return this.transport;
    }
    async configure(descriptor) {
        if (this.transport?.connected)
            throw new RdpError('SESSION_ACTIVE', 'Detach before replacing the session');
        this.descriptor = descriptor;
    }
    async lease(action, args = {}) {
        const lease = this.descriptor?.lease;
        if (!lease)
            return null;
        const endpoint = new URL(lease.endpoint);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
            throw new RdpError('LEASE_ENDPOINT', 'Owner IPC must use loopback');
        const requestId = randomUUID();
        const response = await fetch(new URL('/command', endpoint), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, target: lease.target, action, args, timeoutMs: 1500, token: lease.token, leaseId: lease.leaseId }),
        });
        const packet = await response.json();
        if (packet?.requestId !== requestId)
            throw new RdpError('LEASE_RESPONSE_MISMATCH', 'Owner response requestId does not match the command');
        if (!response.ok || packet.ok !== true)
            throw new RdpError(packet.error?.code ?? 'LEASE_FAILED', packet.error?.message ?? 'Owner command failed');
        return packet.result;
    }
    async attach(args = {}) {
        if (this.transport?.connected) {
            const requested = {
                port: args.debuggerPort ?? args.port,
                contextId: args.contextId,
                browserId: args.browserId,
                descriptorActor: args.descriptorActor,
                scope: args.scope,
                includeSharedWorkers: args.includeSharedWorkers,
                sharedWorkerUrls: args.sharedWorkerUrls ? [...args.sharedWorkerUrls].sort().join('\n') : undefined,
            };
            const current = {
                port: this.descriptor?.port,
                contextId: this.descriptor?.contextId,
                browserId: this.descriptor?.browserId,
                descriptorActor: this.sessionOptions.descriptorActor,
                scope: this.sessionOptions.scope,
                includeSharedWorkers: this.sessionOptions.includeSharedWorkers,
                sharedWorkerUrls: this.sessionOptions.sharedWorkerUrls ? [...this.sessionOptions.sharedWorkerUrls].sort().join('\n') : undefined,
            };
            if (Object.entries(requested).some(([key, value]) => value !== undefined && value !== current[key])) {
                throw new RdpError('SESSION_ACTIVE', 'Native debugger is already attached to a different target/session; detach first');
            }
            return this.status();
        }
        if (this.attachPromise)
            return this.attachPromise;
        this.attachPromise = this.attachInternal(args).finally(() => { this.attachPromise = undefined; });
        return this.attachPromise;
    }
    async attachInternal(args) {
        if (this.transport?.connected)
            return this.status();
        const supplied = args.debuggerPort ?? args.port;
        const session = this.descriptor ?? await this.getSession();
        if (!session && !supplied)
            throw new RdpError('RDP_NOT_RESERVED', 'Launch or attach a browser with an RDP endpoint');
        if (session?.lease) {
            if (supplied !== undefined && Number(supplied) !== session.port || args.browserId !== undefined && Number(args.browserId) !== session.browserId || args.contextId !== undefined && String(args.contextId) !== String(session.contextId) || args.descriptorActor !== undefined) {
                throw new RdpError('SESSION_IDENTITY_MISMATCH', 'Borrowed trace identity cannot be overridden');
            }
        }
        this.descriptor = { ...session, port: supplied === undefined ? session.port : integer(supplied, 0, 1, 65535) };
        this.sessionOptions = args;
        this.sharedWorkerUrls = new Set(Array.isArray(args.sharedWorkerUrls)
            ? args.sharedWorkerUrls.map((value) => {
                const parsed = new URL(String(value));
                if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
                    throw new RdpError('INVALID_ARGUMENT', 'sharedWorkerUrls must be credential-free HTTP(S) URLs');
                }
                return parsed.href;
            }).slice(0, 16)
            : []);
        this.watchdogSeconds = integer(args.autoResumeAfter, 30, 1, 30);
        this.mode = 'observe';
        const transport = new RdpTransport();
        this.transport = transport;
        transport.on('event', packet => this.handleEvent(packet));
        transport.on('closed', error => this.invalidate(error));
        try {
            if (this.descriptor.lease && !this.descriptor.lease.leaseId) {
                const leased = await this.lease('lease.acquire', { seconds: 120 });
                if (typeof leased?.leaseId !== 'string' || !leased.leaseId)
                    throw new RdpError('LEASE_FAILED', 'Owner did not return a lease ID');
                this.descriptor.lease.leaseId = leased.leaseId;
                this.ownsLease = true;
            }
            await transport.open(this.descriptor.host ?? '127.0.0.1', this.descriptor.port);
            const tabs = (await transport.request('root', 'listTabs')).tabs ?? [];
            const requestedActor = args.descriptorActor;
            const contextId = args.contextId ?? this.descriptor.contextId;
            const browserId = args.browserId ?? this.descriptor.browserId;
            const numericContext = contextId !== undefined && /^\d+$/.test(String(contextId));
            const matches = tabs.filter((tab) => requestedActor ? tab.actor === requestedActor : browserId !== undefined ? Number(tab.browserId) === Number(browserId) : numericContext ? String(tab.browsingContextID) === String(contextId) : tabs.length === 1 && this.descriptor?.owner === 'owned');
            if (matches.length !== 1)
                throw new RdpError('TARGET_AMBIGUOUS', 'Provide an exact descriptorActor, browserId or contextId', { tabs: tabs.map((tab) => ({ actor: tab.actor, browserId: tab.browserId, contextId: tab.browsingContextID, url: tab.url })) });
            this.tabDescriptor = matches[0].actor;
            this.descriptor.browserId = matches[0].browserId;
            const watched = await transport.request(this.tabDescriptor, 'getWatcher', { isServerTargetSwitchingEnabled: true, isPopupDebuggingEnabled: false });
            this.watcher = actorOf(watched);
            this.watcherTraits = { tab: watched.traits ?? {} };
            if (!this.watcher)
                throw new RdpError('WATCHER_UNSUPPORTED', 'Runtime did not provide a native watcher');
            this.breakpointActor = actorOf((await transport.request(this.watcher, 'getBreakpointListActor')).breakpointList);
            this.configurationActor = actorOf((await transport.request(this.watcher, 'getThreadConfigurationActor')).configuration);
            if (args.scope === 'browser' || args.includeSharedWorkers === true) {
                const process = (await transport.request('root', 'getProcess', { id: 0 })).processDescriptor;
                const shared = await transport.request(actorOf(process), 'getWatcher', { enableWindowGlobalThreadActors: true });
                if (!shared.traits?.shared_worker)
                    throw new RdpError('TARGET_TYPE_UNSUPPORTED', 'Browser watcher does not support shared_worker');
                this.sharedWatcher = actorOf(shared);
                this.watcherTraits.shared = shared.traits;
                this.sharedBreakpointActor = actorOf((await transport.request(this.sharedWatcher, 'getBreakpointListActor')).breakpointList);
                this.sharedConfigurationActor = actorOf((await transport.request(this.sharedWatcher, 'getThreadConfigurationActor')).configuration);
            }
            await this.syncPreferredTopTarget();
            await this.updateConfiguration({ skipBreakpoints: true, shouldPauseOnDebuggerStatement: false, pauseOnExceptions: false, shouldIncludeSavedFrames: true, shouldIncludeAsyncLiveFrames: true, pauseWorkersUntilAttach: true, observeWasm: true });
            const types = ['frame', ...(args.workers === false ? [] : ['worker', 'service_worker'])];
            for (const type of types) {
                if (!watched.traits?.[type])
                    throw new RdpError('TARGET_TYPE_UNSUPPORTED', `Watcher does not support ${type}`);
                await transport.request(this.watcher, 'watchTargets', { targetType: type });
            }
            if (this.sharedWatcher)
                await transport.request(this.sharedWatcher, 'watchTargets', { targetType: 'shared_worker' });
            await transport.request(this.watcher, 'watchResources', { resourceTypes: ['source', 'console-message'] });
            if (this.sharedWatcher)
                await transport.request(this.sharedWatcher, 'watchResources', { resourceTypes: ['source', 'console-message'] });
            await Promise.all([...this.targetTasks]);
            await Promise.all([...this.targets.values()].map(target => target.ready));
            if (!this.targets.size)
                throw new RdpError('TARGET_UNAVAILABLE', 'No web target was exposed by the watcher');
            const target = [...this.targets.values()].find(item => item.id === this.preferredTopTarget);
            if (!target)
                throw new RdpError('TARGET_UNAVAILABLE', 'Exact top-level target is not available');
            this.selected = target.id;
            if (args.mode === 'armed')
                await this.arm();
            if (this.descriptor.lease) {
                this.leaseTimer = setInterval(() => { void this.lease('status').then(status => { if (status?.lease?.revoked || status?.accepting === false)
                    void this.close(); }).catch(() => { void this.close(); }); }, 500);
                this.leaseTimer.unref();
            }
            return this.status();
        }
        catch (error) {
            await this.close();
            throw error;
        }
    }
    invalidate(error) {
        for (const target of this.targets.values()) {
            clearTimeout(target.watchdog);
            target.grips.clear();
            target.paused = undefined;
            target.pauseId = undefined;
            target.pauseSequence = undefined;
        }
        for (const waiter of this.evaluationWaiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.evaluationWaiters.clear();
        this.evaluationResults.clear();
        this.sourceOwners.clear();
        this.maps.clear();
        this.emit('invalidated', error);
    }
    async addTarget(form) {
        if (!form.actor || !form.threadActor || this.targets.has(form.actor))
            return;
        if (form.url && /^(chrome|resource|moz-extension):/.test(form.url))
            return;
        if (!(await this.targetBelongsToSession(form))) {
            this.emit('diagnostic', { rejectedTarget: { targetType: form.targetType, type: form.type, url: form.url, relatedDocumentInnerWindowId: form.relatedDocumentInnerWindowId, contextId: form.browsingContextID, parentInnerWindowId: form.parentInnerWindowId, topInnerWindowId: form.topInnerWindowId }, reason: 'target-scope-mismatch' });
            return;
        }
        const type = form.targetType ?? (form.type === 0 ? 'worker' : form.type === 1 ? 'shared_worker' : form.type === 2 ? 'service_worker' : form.traits?.isBrowsingContext || form.browsingContextID ? 'frame' : 'worker');
        const target = { id: form.actor, form, thread: form.threadActor, type, grips: new Map(), ready: Promise.resolve() };
        this.targets.set(target.id, target);
        if (form.actor === this.preferredTopTarget && (!this.selected || !this.targets.has(this.selected)))
            this.selected = target.id;
        target.ready = this.connection().request(target.thread, 'attach', { options: this.threadOptions() }).then(async () => {
            if (type === 'shared_worker' && form.identityBinding === 'explicit-allowlist-pending') {
                const sources = (await this.connection().request(target.thread, 'sources')).sources ?? [];
                const matched = sources.find((source) => this.sharedWorkerUrls.has(String(source.url)));
                if (!matched) {
                    this.targets.delete(target.id);
                    throw new RdpError('TARGET_SCOPE_MISMATCH', 'Shared worker sources did not match sharedWorkerUrls');
                }
                form.url = matched.url;
                form.identityBinding = 'explicit-source-url';
            }
        }).catch(error => {
            if (error instanceof RdpError && ['wrongState', 'alreadyAttached'].includes(error.code))
                return;
            if (error instanceof RdpError && error.code === 'TARGET_SCOPE_MISMATCH') {
                this.emit('diagnostic', { targetId: target.id, error: error.message });
                return;
            }
            throw error;
        });
        void target.ready.catch(error => this.emit('diagnostic', { targetId: target.id, error: String(error) }));
        this.emit('target', { targetId: target.id, type });
    }
    async syncPreferredTopTarget() {
        if (!this.tabDescriptor)
            return;
        const tab = (await this.connection().request('root', 'getTab', { browserId: this.descriptor.browserId })).tab;
        if (!tab || Number(tab.browserId) !== this.descriptor.browserId)
            throw new RdpError('TARGET_EXPIRED', `The attached browser identity changed (${this.descriptor.browserId} -> ${tab?.browserId})`);
        this.tabDescriptor = tab.actor;
        this.preferredContextId = String(tab.browsingContextID);
    }
    async targetBelongsToSession(form) {
        const isFrame = Boolean(form.traits?.isBrowsingContext || form.browsingContextID !== undefined || form.isTopLevelTarget);
        const isTop = isFrame && !form.parentInnerWindowId;
        if (isFrame) {
            if (isTop) {
                await this.syncPreferredTopTarget();
                if (String(form.browsingContextID) !== this.preferredContextId)
                    return false;
                this.preferredTopTarget = form.actor;
                this.preferredTopInnerWindowId = Number(form.innerWindowId);
            }
            if (!isTop && (this.preferredTopInnerWindowId === undefined || form.topInnerWindowId === undefined || Number(form.topInnerWindowId) !== this.preferredTopInnerWindowId))
                return false;
            if (form.innerWindowId !== undefined)
                this.allowedInnerWindowIds.add(Number(form.innerWindowId));
            return true;
        }
        const related = Number(form.relatedDocumentInnerWindowId);
        if (Number.isFinite(related) && this.allowedInnerWindowIds.has(related))
            return true;
        if (form.targetType === 'service_worker' || form.targetType === 'shared_worker') {
            const origin = this.currentOrigin();
            if (!origin)
                return false;
            if (form.targetType === 'shared_worker') {
                if (!this.sharedWorkerUrls.size)
                    return false;
                if (!form.url) {
                    form.identityBinding = 'explicit-allowlist-pending';
                    form.identityScope = 'browser';
                    return true;
                }
                const resolved = new URL(String(form.url), origin).href;
                if (!this.sharedWorkerUrls.has(resolved) || new URL(resolved).origin !== origin)
                    return false;
                form.url = resolved;
                form.identityBinding = 'explicit-source-url';
                form.identityScope = 'browser';
                return true;
            }
            try {
                if (!/^https?:/.test(String(form.url))) {
                    const consoleActor = form.consoleActor;
                    if (!consoleActor)
                        return false;
                    const response = await this.connection().request(consoleActor, 'evaluateJSAsync', { text: 'self.location.href', eager: true, disableBreaks: true });
                    const evaluated = await this.evaluationResult(String(response.resultID));
                    if (typeof evaluated.result !== 'string')
                        return false;
                    form.url = evaluated.result;
                    form.identityBinding = 'native-worker-location';
                }
                form.identityScope = 'registration-origin';
                return new URL(form.url).origin === origin;
            }
            catch {
                return false;
            }
        }
        return false;
    }
    threadOptions() {
        return { ...this.configuration };
    }
    currentOrigin() {
        const target = this.preferredTopTarget ? this.targets.get(this.preferredTopTarget) : undefined;
        try {
            const origin = new URL(target?.form.url ?? this.sessionOptions.navigationUrl ?? '').origin;
            return origin === 'null' ? null : origin;
        }
        catch {
            return null;
        }
    }
    handleEvent(packet) {
        if (packet.type === 'target-available-form') {
            const task = this.addTarget(packet.target);
            this.targetTasks.add(task);
            void task.catch(error => this.emit('diagnostic', { error: String(error) })).finally(() => this.targetTasks.delete(task));
            return;
        }
        if (packet.type === 'target-destroyed-form') {
            const target = this.targets.get(packet.target?.actor);
            if (target) {
                clearTimeout(target.watchdog);
                target.grips.clear();
                this.targets.delete(target.id);
            }
            this.maps.clear();
            this.emit('target-destroyed', packet.target?.actor);
            return;
        }
        if (packet.type === 'resources-available-array') {
            for (const group of packet.array ?? [])
                for (const resource of Array.isArray(group[1]) ? group[1] : []) {
                    if (group[0] === 'console-message') {
                        this.logs.push(resource);
                        this.logs = this.logs.slice(-200);
                        this.emit('console', resource);
                    }
                    if (group[0] === 'source' && resource.actor && resource.targetActor)
                        this.sourceOwners.set(resource.actor, resource.targetActor);
                }
            return;
        }
        if (packet.type === 'evaluationResult') {
            const key = String(packet.resultID);
            const waiter = this.evaluationWaiters.get(key);
            if (waiter) {
                clearTimeout(waiter.timer);
                this.evaluationWaiters.delete(key);
                waiter.resolve(packet);
            }
            else {
                this.evaluationResults.set(key, packet);
                if (this.evaluationResults.size > 32)
                    this.evaluationResults.delete(this.evaluationResults.keys().next().value);
            }
            return;
        }
        const target = [...this.targets.values()].find(item => item.thread === packet.from);
        if (!target)
            return;
        if (packet.type === 'resumed') {
            clearTimeout(target.watchdog);
            target.paused = undefined;
            target.pauseId = undefined;
            target.pauseSequence = undefined;
            target.grips.clear();
            if (!this.closing)
                void this.lease('lease.pause', { paused: [...this.targets.values()].some(item => Boolean(item.paused)) }).catch(() => { });
            this.emit('resumed', { targetId: target.id });
        }
        else if (packet.type === 'paused') {
            clearTimeout(target.watchdog);
            target.pauseSequence = ++this.sequence;
            target.pauseId = `${this.transport.epoch}:${target.pauseSequence}`;
            target.paused = packet;
            target.grips.clear();
            this.rememberGrips(target, packet);
            const pauseId = target.pauseId;
            target.watchdog = setTimeout(() => { if (target.pauseId === pauseId)
                void this.resume(target.id).catch(() => this.close()); }, this.watchdogSeconds * 1000);
            target.watchdog.unref();
            void this.lease('lease.pause', { paused: true }).catch(() => this.close());
            if (this.mode === 'observe') {
                void this.resume(target.id).catch(() => this.close());
                return;
            }
            this.emit('paused', this.pauseSummary(target));
            for (const record of this.breakpoints.values())
                if (record.temporary && record.targetId === target.id)
                    void this.removeBreakpoint(record.breakpointId).catch(() => { });
        }
    }
    rememberGrips(target, value, depth = 0) {
        if (depth > 12 || !value || typeof value !== 'object')
            return;
        if (value.actor && target.pauseId)
            target.grips.set(String(value.actor), target.pauseId);
        for (const item of Object.values(value))
            this.rememberGrips(target, item, depth + 1);
    }
    target(args = {}) {
        this.connection();
        const id = String(args.targetId ?? this.selected ?? '');
        const target = this.targets.get(id);
        if (!target)
            throw new RdpError('TARGET_EXPIRED', 'Select a current native target', { targetId: id });
        return target;
    }
    paused(args = {}) {
        const target = this.target(args);
        if (!target.paused || !target.pauseId)
            throw new RdpError('NOT_PAUSED', 'Target is not paused');
        if (args.pauseId && args.pauseId !== target.pauseId)
            throw new RdpError('STALE_PAUSE', 'Pause handle expired after resume or step');
        return target;
    }
    pauseSummary(target) {
        const packet = target.paused;
        return { paused: Boolean(packet), targetId: target.id, pauseId: target.pauseId ?? null, state: packet ? { why: packet.why?.type, reason: packet.why, frame: packet.frame, frameActor: packet.frame?.actor, line: packet.frame?.where?.line, column: packet.frame?.where?.column, sourceActor: packet.frame?.where?.actor, exception: packet.why?.exception, conditionFailed: packet.why?.type === 'breakpointConditionThrown' } : null };
    }
    status() {
        return { started: Boolean(this.transport?.connected), mode: this.mode, epoch: this.transport?.epoch ?? null, runId: this.descriptor?.runId ?? null, port: this.descriptor?.port ?? null, selectedTarget: this.selected ?? null, watchdogSeconds: this.watchdogSeconds, breakpointCount: this.breakpoints.size, targets: [...this.targets.values()].map(target => ({ targetId: target.id, type: target.type, url: target.form.url, contextId: target.form.browsingContextID, browserId: target.form.browserId, ...this.pauseSummary(target) })) };
    }
    async updateConfiguration(configuration) {
        this.configuration = { ...this.configuration, ...configuration };
        if (this.configurationActor)
            await this.connection().request(this.configurationActor, 'updateConfiguration', { configuration });
        if (this.sharedConfigurationActor)
            await this.connection().request(this.sharedConfigurationActor, 'updateConfiguration', { configuration });
        for (const target of this.targets.values())
            await this.connection().request(target.thread, 'reconfigure', { options: configuration });
    }
    async arm() {
        this.connection();
        await this.updateConfiguration({ skipBreakpoints: false, shouldPauseOnDebuggerStatement: true });
        this.mode = 'armed';
        return this.status();
    }
    pausedTargetsNewestFirst() {
        // Firefox requires nested debugger event loops to resume in pause order,
        // newest first. Target registration order is independent of pause order.
        return [...this.targets.values()].filter(target => target.paused)
            .sort((a, b) => (b.pauseSequence ?? 0) - (a.pauseSequence ?? 0));
    }
    async observe() {
        await this.updateConfiguration({ skipBreakpoints: true, shouldPauseOnDebuggerStatement: false, pauseOnExceptions: false });
        this.mode = 'observe';
        for (const target of this.pausedTargetsNewestFirst())
            if (target.paused)
                await this.resume(target.id);
        return this.status();
    }
    async sources(args = {}) {
        const target = this.target(args);
        await target.ready;
        const sources = (await this.connection().request(target.thread, 'sources')).sources ?? [];
        for (const source of sources)
            this.sourceOwners.set(source.actor, target.id);
        return { targetId: target.id, sources: sources.filter((source) => (!args.urlContains || String(source.url ?? '').includes(args.urlContains)) && (!args.sourceActor || source.actor === args.sourceActor)).slice(0, 500).map((source) => ({ ...source, sourceActor: source.actor, targetId: target.id })), truncated: sources.length > 500 };
    }
    async source(args) {
        const target = this.target(args);
        const sources = (await this.sources({ targetId: target.id })).sources;
        const matches = sources.filter((source) => args.sourceActor ? source.actor === args.sourceActor : source.url === args.url);
        if (matches.length !== 1)
            throw new RdpError(matches.length ? 'SOURCE_AMBIGUOUS' : 'SOURCE_EXPIRED', 'Use an exact current sourceActor', { count: matches.length });
        return { source: matches[0], target };
    }
    async sourceText(args) {
        const { source, target } = await this.source(args);
        const reply = await this.connection().request(source.actor, 'source');
        let text = reply.source;
        if (text?.typeName === 'arraybuffer' || text?.type === 'arrayBuffer' || reply.contentType === 'text/wasm') {
            const actor = actorOf(text);
            const length = integer(text.length, 0, 0, 32 * 1024 * 1024);
            const offset = integer(args.offset, 0, 0, length);
            const count = Math.min(integer(args.length, 65536, 1, 1024 * 1024), length - offset);
            const data = await this.connection().request(actor, 'slice', { start: offset, count });
            return { sourceActor: source.actor, targetId: target.id, sourceType: 'wasm', contentType: reply.contentType, byteLength: length, offset, data: data.encoded ?? data, truncated: offset + count < length };
        }
        if (typeof text !== 'string' && text?.type === 'longString') {
            const length = integer(text.length, 0, 0, 32 * 1024 * 1024);
            const rest = await this.connection().request(text.actor, 'substring', { start: 0, end: length });
            text = rest.substring;
        }
        if (typeof text !== 'string')
            throw new RdpError('SOURCE_FORMAT', 'Unsupported source representation');
        const hash = createHash('sha256').update(text).digest('hex');
        let offset = integer(args.offset, 0, 0, text.length);
        let end = Math.min(text.length, offset + integer(args.length, 16000, 1, 1024 * 1024));
        if (args.startLine !== undefined) {
            const startLine = integer(args.startLine, 1, 1, 10_000_000);
            const endLine = integer(args.endLine, startLine + 20, startLine, 10_000_000);
            const lines = text.split('\n');
            offset = lines.slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
            end = Math.min(text.length, offset + lines.slice(startLine - 1, endLine).join('\n').length, offset + 1024 * 1024);
        }
        return { sourceActor: source.actor, targetId: target.id, url: source.url, sourceMapURL: source.sourceMapURL, sourceMapBaseURL: source.sourceMapBaseURL, source: text.slice(offset, end), hash, totalLength: text.length, offset, length: end - offset, truncated: offset > 0 || end < text.length };
    }
    async positions(args) {
        const { source, target } = await this.source(args);
        const query = args.startLine ? { start: { line: args.startLine, column: args.startColumn ?? 0 }, end: { line: args.endLine ?? args.startLine + 100, column: args.endColumn ?? 1000000 } } : null;
        const result = await this.connection().request(source.actor, 'getBreakpointPositionsCompressed', { query });
        return { targetId: target.id, sourceActor: source.actor, positions: result.positions ?? {} };
    }
    async setBreakpoint(args) {
        const target = this.target(args);
        if (Boolean(args.url) === Boolean(args.sourceActor))
            throw new RdpError('INVALID_ARGUMENT', 'Exactly one of url or sourceActor is required');
        const line = integer(args.line, 0, 1, 10_000_000);
        let column = args.column === undefined ? undefined : integer(args.column, 0, 0, 100_000_000);
        let sourceActor = args.sourceActor;
        let pending = false;
        if (args.sourceActor) {
            const { source } = await this.source(args);
            sourceActor = source.actor;
            const positions = (await this.positions(args)).positions;
            const columns = positions[String(line)] ?? [];
            if (!columns.length || column !== undefined && !columns.includes(column))
                throw new RdpError('NOT_BREAKABLE', 'Requested source position is not breakable', { columns });
            column ??= Math.min(...columns);
        }
        else if (column === undefined) {
            const sources = (await this.sources({ targetId: target.id })).sources.filter((source) => source.url === args.url);
            if (sources.length) {
                const columns = [];
                for (const source of sources)
                    columns.push(...((await this.positions({ targetId: target.id, sourceActor: source.actor })).positions[String(line)] ?? []));
                if (!columns.length)
                    throw new RdpError('NOT_BREAKABLE', 'Requested source line is not breakable');
                column = Math.min(...columns);
            }
            else {
                throw new RdpError('PENDING_COLUMN_REQUIRED', 'An unloaded URL requires an explicit generated column; resolve it from the known source or source map before arming');
            }
        }
        const location = args.sourceActor ? { sourceId: sourceActor, line, column } : { sourceUrl: String(args.url), line, column };
        const options = { ...(args.condition ? { condition: String(args.condition) } : {}), ...(args.logValue ? { logValue: String(args.logValue) } : {}) };
        if (args.url && this.currentOrigin()) {
            let origin;
            try {
                origin = new URL(String(args.url)).origin;
            }
            catch {
                throw new RdpError('INVALID_ARGUMENT', 'URL breakpoint requires an absolute URL');
            }
            const known = (await this.sources({ targetId: target.id })).sources.some((source) => source.url === args.url);
            if (!known && origin !== this.currentOrigin())
                throw new RdpError('SOURCE_SCOPE_MISMATCH', 'Pending URL must belong to the selected origin or be an already loaded source');
        }
        const actor = args.sourceActor ? target.thread : target.type === 'shared_worker' ? this.sharedBreakpointActor : this.breakpointActor;
        await this.connection().request(actor, 'setBreakpoint', { location, options });
        if (!args.sourceActor && this.sharedBreakpointActor && actor !== this.sharedBreakpointActor)
            await this.connection().request(this.sharedBreakpointActor, 'setBreakpoint', { location, options });
        const record = { breakpointId: randomUUID(), targetId: target.id, location, options, kind: args.logValue ? 'logpoint' : 'code', temporary: Boolean(args.temporary), actor };
        this.breakpoints.set(record.breakpointId, record);
        return { ...record, type: 'native', sourceActor: sourceActor ?? null, url: args.url ?? null, line, column, pending, mode: this.mode };
    }
    async removeBreakpoint(id) {
        const record = this.breakpoints.get(id);
        if (!record)
            throw new RdpError('BREAKPOINT_EXPIRED', 'Unknown breakpoint');
        if (record.kind === 'xhr')
            await this.connection().request(record.actor, 'removeXHRBreakpoint', { path: record.path, method: record.method });
        else if (record.kind === 'dom')
            await this.connection().request(record.actor, 'setMutationBreakpoints', { node: record.node, subtree: false, attribute: false, removal: false });
        else {
            await this.connection().request(record.actor, 'removeBreakpoint', { location: record.location, options: record.options ?? {} });
            if (record.location?.sourceUrl && this.sharedBreakpointActor && record.actor !== this.sharedBreakpointActor)
                await this.connection().request(this.sharedBreakpointActor, 'removeBreakpoint', { location: record.location, options: record.options ?? {} });
        }
        this.breakpoints.delete(id);
        return { removed: id };
    }
    async waitPaused(args = {}) {
        const target = args.targetId ? this.target(args) : undefined;
        const existing = target ?? [...this.targets.values()].find(item => item.paused && item.pauseId !== args.afterPauseId);
        if (existing?.paused && existing.pauseId !== args.afterPauseId)
            return this.pauseSummary(existing);
        const timeout = integer(args.timeout, 30, 0, 120);
        if (!timeout)
            return { paused: false, timedOut: true };
        return new Promise((resolve, reject) => {
            const finish = () => { clearTimeout(timer); this.off('paused', onPause); this.off('invalidated', onInvalidated); };
            const onPause = (state) => { if ((!target || state.targetId === target.id) && state.pauseId !== args.afterPauseId) {
                finish();
                resolve(state);
            } };
            const onInvalidated = (error) => { finish(); reject(error); };
            const timer = setTimeout(() => { finish(); resolve({ paused: false, timedOut: true }); }, timeout * 1000);
            this.on('paused', onPause);
            this.on('invalidated', onInvalidated);
        });
    }
    async resume(targetId, step, frameActor) {
        const target = this.paused({ targetId });
        const pauseId = target.pauseId;
        const params = {};
        if (step)
            params.resumeLimit = { type: { over: 'next', into: 'step', out: 'finish', restart: 'restart' }[step] ?? step };
        if (frameActor) {
            if (target.grips.get(frameActor) !== pauseId)
                throw new RdpError('STALE_FRAME', 'Frame does not belong to this pause');
            params.frameActorID = frameActor;
        }
        await this.connection().request(target.thread, 'resume', params);
        if (target.pauseId === pauseId) {
            clearTimeout(target.watchdog);
            target.paused = undefined;
            target.pauseId = undefined;
            target.pauseSequence = undefined;
            target.grips.clear();
        }
        return { resumed: true, invalidatedPauseId: pauseId, targetId: target.id, ...this.pauseSummary(target) };
    }
    async frames(args = {}) {
        const target = this.paused(args);
        const pauseId = target.pauseId;
        const reply = await this.connection().request(target.thread, 'frames', { start: integer(args.start, 0, 0, 10000), count: integer(args.count, 50, 1, 100) });
        if (target.pauseId !== pauseId)
            throw new RdpError('STALE_PAUSE', 'Target resumed while reading frames');
        this.rememberGrips(target, reply.frames);
        return { targetId: target.id, pauseId, frames: bounded(reply.frames ?? []) };
    }
    async scopes(args = {}) {
        const target = this.paused(args);
        const pauseId = target.pauseId;
        const frame = String(args.frameActor ?? target.paused.frame?.actor ?? '');
        if (!frame || target.grips.get(frame) !== pauseId)
            throw new RdpError('STALE_FRAME', 'Frame does not belong to this pause');
        let environment = await this.connection().request(frame, 'getEnvironment');
        const scopes = [];
        const scope = {};
        const maxDepth = integer(args.maxDepth, args.includeParents === false ? 2 : 8, 1, 20);
        while (environment && scopes.length < maxDepth) {
            if (environment.scopeKind === 'global' && !args.includeGlobal)
                break;
            const bindings = environment.bindings ?? {};
            this.rememberGrips(target, bindings);
            scopes.push({ actor: environment.actor, type: environment.type, scopeKind: environment.scopeKind, function: environment.function, bindings: bounded(bindings) });
            for (const entry of bindings.arguments ?? [])
                for (const [name, descriptor] of Object.entries(entry))
                    if (!(name in scope))
                        scope[name] = descriptor.value;
            for (const [name, descriptor] of Object.entries(bindings.variables ?? {}))
                if (!(name in scope))
                    scope[name] = descriptor.value;
            if (args.includeParents === false && environment.type === 'function')
                break;
            environment = environment.parent;
        }
        if (target.pauseId !== pauseId)
            throw new RdpError('STALE_PAUSE', 'Target resumed while reading scopes');
        return { targetId: target.id, pauseId, scopes, scope: bounded(scope), truncated: Boolean(environment?.parent && scopes.length >= maxDepth) };
    }
    async objects(args) {
        const target = this.paused(args);
        const pauseId = target.pauseId;
        const actor = String(args.actor ?? '');
        if (target.grips.get(actor) !== pauseId)
            throw new RdpError('STALE_GRIP', 'Object handle does not belong to this pause');
        let result;
        if (args.property !== undefined)
            result = await this.connection().request(actor, 'property', { name: String(args.property) });
        else if (args.action === 'release') {
            result = await this.connection().request(actor, 'release');
            target.grips.delete(actor);
        }
        else {
            const iterator = (await this.connection().request(actor, 'enumProperties', { options: { ignoreNonIndexedProperties: false, ignoreIndexedProperties: false, sort: true } })).iterator;
            try {
                result = await this.connection().request(actorOf(iterator), 'slice', { start: integer(args.start, 0, 0, 1000000), count: integer(args.maxItems, 80, 1, 200) });
            }
            finally {
                await this.connection().request(actorOf(iterator), 'release').catch(() => { });
            }
            result.count = iterator.count;
        }
        if (target.pauseId !== pauseId)
            throw new RdpError('STALE_PAUSE', 'Target resumed while expanding object');
        this.rememberGrips(target, result);
        return { targetId: target.id, pauseId, value: bounded(result) };
    }
    async evaluate(args) {
        const target = args.running ? this.target(args) : this.paused(args);
        const pauseId = target.pauseId;
        const frameActor = args.running ? undefined : String(args.frameActor ?? target.paused.frame?.actor ?? '');
        if (frameActor && target.grips.get(frameActor) !== pauseId)
            throw new RdpError('STALE_FRAME', 'Frame does not belong to this pause');
        const consoleActor = target.form.consoleActor;
        if (!consoleActor)
            throw new RdpError('EVALUATION_UNSUPPORTED', 'Target has no native console actor');
        const response = await this.connection().request(consoleActor, 'evaluateJSAsync', { text: String(args.expression ?? args.function ?? ''), frameActor, eager: args.allowSideEffects !== true, disableBreaks: true });
        const result = await this.evaluationResult(String(response.resultID), integer(args.timeout, 5, 1, 15));
        if (!args.running && target.pauseId !== pauseId)
            throw new RdpError('STALE_PAUSE', 'Target resumed while evaluating');
        if (target.pauseId)
            this.rememberGrips(target, result);
        return { targetId: target.id, pauseId, evaluation: bounded(result), result: bounded(result.result), exception: bounded(result.exception) };
    }
    async evaluationResult(key, timeoutSeconds = 5) {
        const ready = this.evaluationResults.get(key);
        this.evaluationResults.delete(key);
        if (ready)
            return ready;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.evaluationWaiters.delete(key); reject(new RdpError('EVALUATION_TIMEOUT', 'Native evaluation timed out')); }, timeoutSeconds * 1000);
            this.evaluationWaiters.set(key, { resolve, reject, timer });
        });
    }
    async search(args) {
        const results = [];
        const query = String(args.text ?? args.query ?? '');
        if (!query)
            throw new RdpError('INVALID_ARGUMENT', 'Search text is required');
        const sourceList = (await this.sources(args)).sources;
        for (const source of sourceList.slice(0, 100)) {
            const body = await this.sourceText({ targetId: source.targetId, sourceActor: source.actor, length: 1024 * 1024 }).catch(() => null);
            if (!body?.source)
                continue;
            let offset = body.source.indexOf(query);
            while (offset >= 0 && results.length < 100) {
                const prefix = body.source.slice(0, offset);
                results.push({ sourceActor: source.actor, url: source.url, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') - 1, text: body.source.slice(offset, offset + Math.min(query.length + 100, 300)) });
                offset = body.source.indexOf(query, offset + Math.max(query.length, 1));
            }
            if (results.length >= 100)
                break;
        }
        return { matches: results, truncated: results.length >= 100 };
    }
    async domBreakpoint(args) {
        const target = this.target(args);
        if (target.type !== 'frame')
            throw new RdpError('UNSUPPORTED', 'DOM mutation breakpoints do not apply to workers');
        let inspector = target.form.inspectorActor;
        if (!inspector)
            inspector = actorOf((await this.connection().request(target.id, 'getTargetScopedActor', { actorName: 'inspector' })).actor);
        const walker = (await this.connection().request(inspector, 'getWalker', { options: {} })).walker;
        const walkerActor = actorOf(walker);
        const node = args.nodeActor ?? actorOf((await this.connection().request(walkerActor, 'querySelector', { node: actorOf(walker.root), selector: String(args.selector) })).node);
        if (!node)
            throw new RdpError('NODE_NOT_FOUND', 'DOM breakpoint selector did not match');
        const settings = { subtree: Boolean(args.subtree), attribute: Boolean(args.attribute), removal: Boolean(args.removal) };
        await this.connection().request(walkerActor, 'setMutationBreakpoints', { node, ...settings });
        const record = { breakpointId: randomUUID(), targetId: target.id, kind: 'dom', actor: walkerActor, node, settings };
        this.breakpoints.set(record.breakpointId, record);
        return record;
    }
    async call(operation, args = {}) {
        try {
            const result = await this.dispatch(operation, args);
            this.observedOperations.add(operation);
            this.emit('operation', { operation, targetId: args.targetId ?? this.selected ?? null, pauseId: args.pauseId ?? null, resultKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 40) : [], at: new Date().toISOString(), hash: createHash('sha256').update(JSON.stringify(result) ?? 'null').digest('hex') });
            return result;
        }
        catch (error) {
            this.emit('operation', { operation, targetId: args.targetId ?? this.selected ?? null, pauseId: args.pauseId ?? null, errorCode: error instanceof RdpError ? error.code : 'NATIVE_DEBUG_ERROR', at: new Date().toISOString() });
            throw error;
        }
    }
    async dispatch(operation, args = {}) {
        switch (operation) {
            case 'debug.enable':
            case 'attach': return this.attach(args);
            case 'debug.disable':
            case 'detach':
                await this.close();
                return { started: false, breakpointCount: 0 };
            case 'debug.status':
            case 'status': return this.status();
            case 'debug.capabilities': return { protocol: 'firefox-rdp', adapterVersion: '0.4.0', reported: { implemented: ['sources', 'possibleBreakpoints', 'urlBreakpoint', 'sourceActorBreakpoint', 'conditionalBreakpoint', 'logpoint', 'step', 'restartFrame', 'runTo', 'asyncFrames', 'exceptions', 'xhrFetch', 'eventBreakpoints', 'domMutation', 'blackbox', 'workers', 'iframe', 'pausedEvaluation', 'scopes', 'properties', 'sourceMaps', 'wasmBinary'], runtime: this.descriptor?.runtime ?? null }, probed: { connected: Boolean(this.transport?.connected), greeting: this.transport?.greeting ?? null, watcherTraits: this.watcherTraits, successfulOperations: [...this.observedOperations] }, verified: { scope: 'external-runtime-receipt-required', receipt: null }, unsupported: ['workerOutgoingXhrFetchBreakpoint', 'workerDomMutation', 'asyncGeneratorFrameRestart', 'wasmDwarfInstructionDebugging'], ...this.status() };
            case 'debug.arm': return this.arm();
            case 'debug.observe': return this.observe();
            case 'debug.targets': return this.status().targets;
            case 'debug.select_target':
                this.selected = this.target(args).id;
                return this.status();
            case 'debug.sources': return this.sources(args);
            case 'debug.source_text': return this.sourceText(args);
            case 'debug.search': return this.search(args);
            case 'debug.positions': return this.positions(args);
            case 'debug.set_breakpoint': return this.setBreakpoint(args);
            case 'debug.set_breakpoint_on_text': {
                const matches = (await this.search({ ...args, urlContains: args.urlFilter })).matches;
                const index = integer(args.occurrence, 0, 0, 99);
                if (!matches[index])
                    throw new RdpError('SOURCE_MATCH_MISSING', 'No matching source occurrence');
                const match = matches[index];
                const positions = (await this.positions({ ...args, sourceActor: match.sourceActor })).positions[String(match.line)] ?? [];
                const column = positions.find((column) => column >= match.column) ?? positions[0];
                return this.setBreakpoint({ ...args, sourceActor: match.sourceActor, url: undefined, line: match.line, column });
            }
            case 'debug.remove_breakpoint': return this.removeBreakpoint(String(args.breakpointId));
            case 'debug.list_breakpoints': return { breakpoints: [...this.breakpoints.values()].filter(record => !args.targetId || record.targetId === args.targetId) };
            case 'debug.wait_paused': return this.waitPaused(args);
            case 'debug.get_paused_info': {
                const target = this.target(args);
                return target.paused ? { ...this.pauseSummary(target), ...await this.frames(args) } : this.pauseSummary(target);
            }
            case 'debug.pause': {
                const target = this.target(args);
                await this.arm();
                await this.connection().request(target.thread, 'interrupt', { when: 'now' });
                return this.waitPaused({ targetId: target.id, timeout: 5 });
            }
            case 'debug.resume': {
                const target = this.paused(args);
                return this.resume(target.id);
            }
            case 'debug.step': {
                const target = this.paused(args);
                const pauseId = target.pauseId;
                await this.resume(target.id, String(args.type ?? 'over'));
                return this.waitPaused({ targetId: target.id, afterPauseId: pauseId, timeout: args.timeout ?? 10 });
            }
            case 'debug.restart': {
                const target = this.paused(args);
                const frames = (await this.frames(args)).frames;
                const frame = frames.find(frame => frame.actor === (args.frameActor ?? target.paused.frame?.actor));
                if (!frame || frame.type !== 'call' || frame.state === 'suspended' || frame.asyncCause)
                    throw new RdpError('UNSUPPORTED', 'Only live synchronous call frames can be restarted');
                const pauseId = target.pauseId;
                await this.resume(target.id, 'restart', frame.actor);
                return this.waitPaused({ targetId: target.id, afterPauseId: pauseId, timeout: 10 });
            }
            case 'debug.run_to': {
                const target = this.paused(args);
                const record = await this.setBreakpoint({ ...args, temporary: true });
                await this.resume(target.id);
                return record;
            }
            case 'debug.frames': return this.frames(args);
            case 'debug.scope': return this.scopes(args);
            case 'debug.expand': return this.objects(args);
            case 'debug.evaluate': return this.evaluate(args);
            case 'debug.pause_on_exceptions':
                await this.updateConfiguration({ pauseOnExceptions: args.enabled !== false, ignoreCaughtExceptions: args.ignoreCaught !== false });
                return { enabled: args.enabled !== false, ignoreCaught: args.ignoreCaught !== false, mode: this.mode, requiresArm: this.mode !== 'armed' };
            case 'debug.break_on_xhr': {
                const target = this.target(args);
                if (target.type !== 'frame')
                    throw new RdpError('UNSUPPORTED', 'Firefox159 has no native worker outgoing XHR/fetch breakpoint');
                const path = String(args.url ?? '');
                const method = String(args.method ?? 'ANY').toUpperCase();
                await this.connection().request(this.breakpointActor, 'setXHRBreakpoint', { path, method });
                const record = { breakpointId: randomUUID(), targetId: target.id, kind: 'xhr', path, method, actor: this.breakpointActor };
                this.breakpoints.set(record.breakpointId, record);
                return { ok: true, heuristic: false, verifiedRequestBreakpoint: true, method, breakpoints: [record], mode: this.mode, requiresArm: this.mode !== 'armed' };
            }
            case 'debug.events': {
                const target = this.target(args);
                if (args.ids) {
                    await this.connection().request(target.thread, 'setActiveEventBreakpoints', { ids: args.ids });
                    return { ids: args.ids, mode: this.mode, requiresArm: this.mode !== 'armed' };
                }
                return this.connection().request(target.thread, 'getAvailableEventBreakpoints');
            }
            case 'debug.dom': return this.domBreakpoint(args);
            case 'debug.blackbox': {
                const { source } = await this.source(args);
                await this.connection().request(source.actor, args.enabled === false ? 'unblackbox' : 'blackbox', { range: args.startLine ? { start: { line: args.startLine, column: args.startColumn ?? 0 }, end: { line: args.endLine ?? args.startLine, column: args.endColumn ?? 1000000 } } : null });
                return { sourceActor: source.actor, enabled: args.enabled !== false };
            }
            case 'debug.logs': return { messages: bounded(this.logs.slice(-integer(args.limit, 50, 1, 100))) };
            case 'debug.map_load': {
                const text = await this.sourceText({ ...args, length: 1024 * 1024 });
                if (text.truncated)
                    throw new RdpError('MAP_SOURCE_LIMIT', 'Mapped source exceeds 1 MiB');
                return this.maps.load({ ...args, sourceActor: text.sourceActor, source: text.source, url: args.mapUrl ?? args.url, path: args.path, map: args.map });
            }
            case 'debug.map_original': return this.maps.original(String(args.mapId), integer(args.line, 1, 1, 10000000), integer(args.column, 0, 0, 100000000));
            case 'debug.map_source': {
                const text = await this.maps.content(String(args.mapId), String(args.source));
                if (text === null)
                    return { source: null, missingSourcesContent: true };
                const offset = integer(args.offset, 0, 0, text.length);
                const length = integer(args.length, 16000, 1, 65536);
                return { source: text.slice(offset, offset + length), offset, totalLength: text.length, truncated: offset > 0 || offset + length < text.length, nextOffset: offset + length < text.length ? offset + length : null };
            }
            case 'debug.map_breakpoint': {
                const mapped = await this.maps.generated(String(args.mapId), String(args.source), integer(args.line, 1, 1, 10000000), integer(args.column, 0, 0, 100000000));
                const text = await this.sourceText({ ...args, sourceActor: mapped.sourceActor, url: undefined });
                if (text.hash !== mapped.sourceHash)
                    throw new RdpError('MAP_EXPIRED', 'Generated source hash changed');
                const positions = (await this.positions({ ...args, sourceActor: mapped.sourceActor, url: undefined })).positions;
                const planted = [];
                for (const position of mapped.positions) {
                    const columns = positions[String(position.line)] ?? [];
                    const column = columns.find(value => value >= position.column);
                    if (column !== undefined)
                        planted.push(await this.setBreakpoint({ ...args, url: undefined, sourceActor: mapped.sourceActor, line: position.line, column }));
                }
                if (!planted.length)
                    throw new RdpError('MAP_NOT_BREAKABLE', 'Original position has no generated breakable location');
                return { ...mapped, requested: { source: args.source, line: args.line, column: args.column ?? 0 }, breakpoints: planted };
            }
            case 'debug.navigate': {
                if (!this.tabDescriptor)
                    throw new RdpError('TARGET_UNAVAILABLE', 'No tab descriptor');
                this.sessionOptions.navigationUrl = String(args.url);
                await this.connection().request(this.tabDescriptor, 'navigateTo', { url: String(args.url), waitForLoad: false });
                await this.syncPreferredTopTarget();
                return { navigated: true };
            }
            default: throw new RdpError('UNKNOWN_OPERATION', `Unknown native debug operation ${operation}`);
        }
    }
    close() {
        if (this.closing)
            return this.closing;
        this.closing = this.closeInternal().finally(() => { this.closing = undefined; });
        return this.closing;
    }
    async closeInternal() {
        clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
        const transport = this.transport;
        let resumed = false;
        for (const target of this.targets.values())
            clearTimeout(target.watchdog);
        if (transport?.connected) {
            for (const target of this.pausedTargetsNewestFirst())
                if (target.paused)
                    await this.resume(target.id).catch(() => { });
            resumed = transport.connected && this.pausedTargetsNewestFirst().length === 0;
            transport.close();
        }
        // These are advisory notifications. Local socket destruction and an HTTP
        // reply are not acknowledgements of remote RDP teardown by Firefox.
        if (this.ownsLease)
            await this.lease('lease.release', { resumed }).catch(() => { });
        else if (resumed)
            await this.lease('lease.pause', { paused: false }).catch(() => { });
        if (this.ownsLease && this.descriptor?.lease)
            this.descriptor.lease.leaseId = undefined;
        this.ownsLease = false;
        this.targets.clear();
        this.breakpoints.clear();
        this.sourceOwners.clear();
        this.maps.clear();
        this.selected = undefined;
        this.watcher = undefined;
        this.tabDescriptor = undefined;
        this.configurationActor = undefined;
        this.breakpointActor = undefined;
        this.sharedWatcher = undefined;
        this.sharedBreakpointActor = undefined;
        this.sharedConfigurationActor = undefined;
        this.watcherTraits = {};
        this.configuration = {};
        this.observedOperations.clear();
        this.preferredTopTarget = undefined;
        this.preferredContextId = undefined;
        this.preferredTopInnerWindowId = undefined;
        this.allowedInnerWindowIds.clear();
        this.targetTasks.clear();
        this.transport = undefined;
        this.descriptor = undefined;
        this.mode = 'observe';
    }
}
export { RdpError, RdpTransport } from './transport.js';
//# sourceMappingURL=index.js.map