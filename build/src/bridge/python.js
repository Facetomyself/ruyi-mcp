/**
 * Python subprocess bridge for ruyipage.
 *
 * Manages a long-lived Python child process running ruyi_bridge.py.
 * Communication via JSON-RPC over stdio: one JSON line per request/response.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function bridgeResultError(result) {
    if (!result || typeof result !== 'object' || !('error' in result)) {
        return null;
    }
    const data = result;
    const message = String(data.error || 'Python bridge returned an error result');
    const stack = typeof data.stack === 'string' ? `\n${data.stack}` : '';
    return new Error(`${message}${stack}`);
}
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON_EXE = process.env.RUYI_MCP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DEFAULT_BRIDGE_SCRIPT = process.env.RUYI_MCP_BRIDGE_SCRIPT
    || resolve(MODULE_DIR, '../../../bridge/ruyi_bridge.py');
const DEFAULT_CALL_TIMEOUT_MS = 120_000; // 2 minutes for browser ops
// ---------------------------------------------------------------------------
// PythonBridge
// ---------------------------------------------------------------------------
export class PythonBridge {
    executable;
    script;
    extraEnv;
    proc = null;
    rl = null;
    generation = 0;
    nextId = 0;
    pending = new Map();
    ready = false;
    readyResolve;
    readyReject;
    readyPromise;
    stoppingPromise = null;
    constructor(options = {}) {
        this.executable = options.executable ?? DEFAULT_PYTHON_EXE;
        this.script = options.script ?? DEFAULT_BRIDGE_SCRIPT;
        this.extraEnv = options.env ?? {};
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
            this.readyReject = () => { };
        });
        this.resetReadyPromise();
    }
    resetReadyPromise() {
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = (reason) => reject(reason ?? new Error('Python bridge failed to become ready'));
        });
    }
    isActiveGeneration(child, generation) {
        return this.proc === child && this.generation === generation;
    }
    rejectGenerationPending(generation, message, exceptId) {
        for (const [id, p] of this.pending) {
            if (p.generation !== generation || id === exceptId)
                continue;
            clearTimeout(p.timer);
            p.reject(new Error(message));
            this.pending.delete(id);
        }
    }
    closeReadline(readline = this.rl) {
        if (readline) {
            if (this.rl === readline) {
                this.rl = null;
            }
            readline.close();
        }
    }
    handleBridgeStdinError(child, generation, err) {
        const code = err.code;
        const detail = code ? `${code}: ${err.message}` : err.message;
        const failure = new Error(`Python bridge stdin write failed (${detail})`);
        if (this.isActiveGeneration(child, generation)) {
            console.error(`[ruyi-mcp] ${failure.message}`);
            this.killBridgeProcess(`stdin write failed (${detail})`);
        }
        return failure;
    }
    writeRequest(request, child, generation) {
        const stdin = child?.stdin;
        if (!this.isActiveGeneration(child, generation)
            || !this.ready
            || !stdin
            || stdin.destroyed
            || !stdin.writable) {
            const error = Object.assign(new Error('Python bridge stdin is not writable'), {
                code: 'ERR_STREAM_DESTROYED',
            });
            return Promise.reject(this.handleBridgeStdinError(child, generation, error));
        }
        const line = JSON.stringify(request) + '\n';
        return new Promise((resolve, reject) => {
            try {
                stdin.write(line, (err) => {
                    if (err) {
                        reject(this.handleBridgeStdinError(child, generation, err));
                    }
                    else {
                        resolve();
                    }
                });
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                reject(this.handleBridgeStdinError(child, generation, error));
            }
        });
    }
    killBridgeProcess(reason) {
        const proc = this.proc;
        if (!proc)
            return;
        const generation = this.generation;
        console.error(`[ruyi-mcp] Terminating Python bridge: ${reason}`);
        const pid = proc.pid;
        this.rejectGenerationPending(generation, `Python bridge terminated: ${reason}`);
        this.closeReadline();
        this.proc = null;
        this.ready = false;
        if (pid && process.platform === 'win32') {
            // Kill only the wedged Python bridge. `/T` also terminates Firefox,
            // destroying the very session that ruyi_attach_browser is meant to
            // recover after a timeout.
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
            killer.on('error', () => {
                try {
                    proc.kill('SIGKILL');
                }
                catch {
                    // Ignore kill errors.
                }
            });
        }
        else {
            try {
                proc.kill('SIGKILL');
            }
            catch {
                // Ignore kill errors.
            }
        }
    }
    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    async start() {
        if (this.proc) {
            await this.readyPromise;
            return;
        }
        if (this.stoppingPromise) {
            await this.stoppingPromise;
            if (this.proc) {
                await this.readyPromise;
                return;
            }
        }
        const generation = ++this.generation;
        this.resetReadyPromise();
        const readyPromise = this.readyPromise;
        const readyResolve = this.readyResolve;
        const readyReject = this.readyReject;
        const stderrLog = [];
        let childReady = false;
        console.error('[ruyi-mcp] Starting Python bridge...');
        const child = spawn(this.executable, [this.script], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...this.extraEnv,
                PYTHONUNBUFFERED: '1',
                PYTHONIOENCODING: 'utf-8',
            },
        });
        this.proc = child;
        child.stdin.on('error', (err) => {
            this.handleBridgeStdinError(child, generation, err);
        });
        // Readline on stdout for JSON-RPC responses
        const readline = createInterface({ input: child.stdout });
        this.rl = readline;
        readline.on('line', (line) => {
            if (!this.isActiveGeneration(child, generation))
                return;
            const trimmed = line.trim();
            if (!trimmed)
                return;
            try {
                const response = JSON.parse(trimmed);
                const id = response.id;
                if (id !== null && id !== undefined) {
                    const pending = this.pending.get(id);
                    if (pending?.generation === generation) {
                        clearTimeout(pending.timer);
                        this.pending.delete(id);
                        if (response.error) {
                            pending.reject(new Error(`[${response.error.code}] ${response.error.message}` +
                                (response.error.data ? `\n${response.error.data}` : '')));
                        }
                        else {
                            const resultError = bridgeResultError(response.result);
                            if (resultError) {
                                pending.reject(resultError);
                            }
                            else {
                                pending.resolve(response.result);
                            }
                        }
                    }
                }
            }
            catch {
                // Ignore non-JSON lines
            }
        });
        readline.on('close', () => {
            if (this.rl === readline) {
                this.rl = null;
            }
        });
        // Stderr for logs
        child.stderr.on('data', (data) => {
            if (!this.isActiveGeneration(child, generation))
                return;
            const msg = data.toString().trim();
            if (msg.includes('[ruyi_bridge] Ready')) {
                childReady = true;
                this.ready = true;
                readyResolve();
                console.error('[ruyi-mcp] Python bridge ready');
            }
            else if (msg) {
                stderrLog.push(msg);
                console.error(`[ruyi-bridge] ${msg}`);
            }
        });
        // Process exit
        child.on('exit', (code) => {
            if (!childReady) {
                const details = stderrLog.length
                    ? ` Last stderr: ${stderrLog[stderrLog.length - 1]}`
                    : '';
                readyReject(new Error(`Python bridge exited before ready (code ${code}).${details}`));
            }
            this.closeReadline(readline);
            if (!this.isActiveGeneration(child, generation))
                return;
            console.error(`[ruyi-mcp] Python bridge exited with code ${code}`);
            this.proc = null;
            this.ready = false;
            this.rejectGenerationPending(generation, `Python bridge exited (code ${code})`);
        });
        child.on('error', (err) => {
            if (!childReady) {
                readyReject(new Error(`Python bridge spawn error: ${err.message}`));
            }
            this.closeReadline(readline);
            if (!this.isActiveGeneration(child, generation))
                return;
            console.error(`[ruyi-mcp] Python bridge spawn error: ${err.message}`);
            this.proc = null;
            this.ready = false;
            this.rejectGenerationPending(generation, `Python bridge spawn error: ${err.message}`);
        });
        // Wait for ready signal
        await readyPromise;
        if (!this.isActiveGeneration(child, generation) || !this.ready) {
            throw new Error('Python bridge stopped before it became ready');
        }
    }
    stop() {
        if (!this.stoppingPromise) {
            // Assign before running stopInternal so simultaneous close paths share
            // one bounded shutdown attempt.
            this.stoppingPromise = Promise.resolve()
                .then(() => this.stopInternal())
                .finally(() => {
                this.stoppingPromise = null;
            });
        }
        return this.stoppingPromise;
    }
    async stopInternal() {
        if (!this.proc)
            return;
        if (!this.ready) {
            this.killBridgeProcess('stop requested before ready');
            return;
        }
        try {
            // Try graceful shutdown
            await this.call('__shutdown__', {}, 5000);
            await this.waitForExit(1000);
        }
        catch {
            // Force kill
        }
        if (this.proc) {
            this.killBridgeProcess('stop requested');
        }
    }
    async waitForExit(timeoutMs) {
        const proc = this.proc;
        if (!proc)
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            proc.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    // ------------------------------------------------------------------
    // RPC
    // ------------------------------------------------------------------
    async call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
        if (this.stoppingPromise && method !== '__shutdown__') {
            throw new Error(`Python bridge is stopping; cannot call ${method}`);
        }
        if (!this.proc || !this.ready) {
            await this.start();
        }
        const child = this.proc;
        const generation = this.generation;
        if (!child || !this.ready) {
            throw new Error('Python bridge stopped before the call could be sent');
        }
        const id = ++this.nextId;
        const request = { id, method, params: params || {} };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                if (!pending || pending.generation !== generation)
                    return;
                this.pending.delete(id);
                reject(new Error(`Python bridge call timeout: ${method} (${timeoutMs}ms)`));
                this.rejectGenerationPending(generation, `Python bridge reset after timeout in ${method} (${timeoutMs}ms)`, id);
                if (this.isActiveGeneration(child, generation)) {
                    this.killBridgeProcess(`call timeout in ${method} (${timeoutMs}ms)`);
                }
            }, timeoutMs);
            this.pending.set(id, { generation, resolve, reject, timer });
            void this.writeRequest(request, child, generation).catch((err) => {
                const pending = this.pending.get(id);
                if (!pending || pending.generation !== generation)
                    return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }
    async notify(method, params) {
        if (this.stoppingPromise) {
            throw new Error(`Python bridge is stopping; cannot notify ${method}`);
        }
        if (!this.proc || !this.ready) {
            await this.start();
        }
        const child = this.proc;
        const generation = this.generation;
        if (!child || !this.ready) {
            throw new Error('Python bridge stopped before the notification could be sent');
        }
        const request = { id: null, method, params: params || {} };
        await this.writeRequest(request, child, generation);
    }
    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------
    isRunning() {
        return this.proc !== null && this.ready && !this.proc.killed;
    }
}
//# sourceMappingURL=python.js.map