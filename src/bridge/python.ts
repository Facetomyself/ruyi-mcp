/**
 * Python subprocess bridge for ruyipage.
 *
 * Manages a long-lived Python child process running ruyi_bridge.py.
 * Communication via JSON-RPC over stdio: one JSON line per request/response.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  id: number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

interface PendingCall {
  generation: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function bridgeResultError(result: unknown): Error | null {
  if (!result || typeof result !== 'object' || !('error' in result)) {
    return null;
  }
  const data = result as Record<string, unknown>;
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

export interface PythonBridgeOptions {
  executable?: string;
  script?: string;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// PythonBridge
// ---------------------------------------------------------------------------

export class PythonBridge {
  private readonly executable: string;
  private readonly script: string;
  private readonly extraEnv: NodeJS.ProcessEnv;
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private generation = 0;
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private ready = false;
  private readyResolve!: () => void;
  private readyReject!: (reason?: Error) => void;
  private readyPromise: Promise<void>;
  private stoppingPromise: Promise<void> | null = null;

  constructor(options: PythonBridgeOptions = {}) {
    this.executable = options.executable ?? DEFAULT_PYTHON_EXE;
    this.script = options.script ?? DEFAULT_BRIDGE_SCRIPT;
    this.extraEnv = options.env ?? {};
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      this.readyReject = () => {};
    });
    this.resetReadyPromise();
  }

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = (reason?: Error) => reject(reason ?? new Error('Python bridge failed to become ready'));
    });
  }

  private isActiveGeneration(child: ChildProcess, generation: number): boolean {
    return this.proc === child && this.generation === generation;
  }

  private rejectGenerationPending(generation: number, message: string, exceptId?: number): void {
    for (const [id, p] of this.pending) {
      if (p.generation !== generation || id === exceptId) continue;
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private closeReadline(readline: Interface | null = this.rl): void {
    if (readline) {
      if (this.rl === readline) {
        this.rl = null;
      }
      readline.close();
    }
  }

  private handleBridgeStdinError(child: ChildProcess, generation: number, err: Error): Error {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code ? `${code}: ${err.message}` : err.message;
    const failure = new Error(`Python bridge stdin write failed (${detail})`);

    if (this.isActiveGeneration(child, generation)) {
      console.error(`[ruyi-mcp] ${failure.message}`);
      this.killBridgeProcess(`stdin write failed (${detail})`);
    }

    return failure;
  }

  private writeRequest(
    request: JsonRpcRequest,
    child: ChildProcess,
    generation: number
  ): Promise<void> {
    const stdin = child?.stdin;
    if (
      !this.isActiveGeneration(child, generation)
      || !this.ready
      || !stdin
      || stdin.destroyed
      || !stdin.writable
    ) {
      const error = Object.assign(new Error('Python bridge stdin is not writable'), {
        code: 'ERR_STREAM_DESTROYED',
      });
      return Promise.reject(this.handleBridgeStdinError(child, generation, error));
    }

    const line = JSON.stringify(request) + '\n';
    return new Promise<void>((resolve, reject) => {
      try {
        stdin.write(line, (err?: Error | null) => {
          if (err) {
            reject(this.handleBridgeStdinError(child, generation, err));
          } else {
            resolve();
          }
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reject(this.handleBridgeStdinError(child, generation, error));
      }
    });
  }

  private killBridgeProcess(reason: string): void {
    const proc = this.proc;
    if (!proc) return;
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
        } catch {
          // Ignore kill errors.
        }
      });
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore kill errors.
      }
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start(): Promise<void> {
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
    const stderrLog: string[] = [];
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

    child.stdin!.on('error', (err) => {
      this.handleBridgeStdinError(child, generation, err);
    });

    // Readline on stdout for JSON-RPC responses
    const readline = createInterface({ input: child.stdout! });
    this.rl = readline;
    readline.on('line', (line: string) => {
      if (!this.isActiveGeneration(child, generation)) return;

      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const response: JsonRpcResponse = JSON.parse(trimmed);
        const id = response.id;
        if (id !== null && id !== undefined) {
          const pending = this.pending.get(id);
          if (pending?.generation === generation) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            if (response.error) {
              pending.reject(
                new Error(
                  `[${response.error.code}] ${response.error.message}` +
                    (response.error.data ? `\n${response.error.data}` : '')
                )
              );
            } else {
              const resultError = bridgeResultError(response.result);
              if (resultError) {
                pending.reject(resultError);
              } else {
                pending.resolve(response.result);
              }
            }
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });
    readline.on('close', () => {
      if (this.rl === readline) {
        this.rl = null;
      }
    });

    // Stderr for logs
    child.stderr!.on('data', (data: Buffer) => {
      if (!this.isActiveGeneration(child, generation)) return;

      const msg = data.toString().trim();
      if (msg.includes('[ruyi_bridge] Ready')) {
        childReady = true;
        this.ready = true;
        readyResolve();
        console.error('[ruyi-mcp] Python bridge ready');
      } else if (msg) {
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
      if (!this.isActiveGeneration(child, generation)) return;

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
      if (!this.isActiveGeneration(child, generation)) return;

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

  stop(): Promise<void> {
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

  private async stopInternal(): Promise<void> {
    if (!this.proc) return;
    if (!this.ready) {
      this.killBridgeProcess('stop requested before ready');
      return;
    }

    try {
      // Try graceful shutdown
      await this.call('__shutdown__', {}, 5000);
      await this.waitForExit(1000);
    } catch {
      // Force kill
    }

    if (this.proc) {
      this.killBridgeProcess('stop requested');
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
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

  async call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS
  ): Promise<unknown> {
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
    const request: JsonRpcRequest = { id, method, params: params || {} };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.generation !== generation) return;
        this.pending.delete(id);
        reject(new Error(`Python bridge call timeout: ${method} (${timeoutMs}ms)`));
        this.rejectGenerationPending(
          generation,
          `Python bridge reset after timeout in ${method} (${timeoutMs}ms)`,
          id
        );
        if (this.isActiveGeneration(child, generation)) {
          this.killBridgeProcess(`call timeout in ${method} (${timeoutMs}ms)`);
        }
      }, timeoutMs);

      this.pending.set(id, { generation, resolve, reject, timer });
      void this.writeRequest(request, child, generation).catch((err) => {
        const pending = this.pending.get(id);
        if (!pending || pending.generation !== generation) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
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

    const request: JsonRpcRequest = { id: null, method, params: params || {} };
    await this.writeRequest(request, child, generation);
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  isRunning(): boolean {
    return this.proc !== null && this.ready && !this.proc.killed;
  }
}
