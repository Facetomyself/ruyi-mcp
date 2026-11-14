import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { resolveSafeOutputPath } from './tools/security.js';
export class DebugEvidence {
    destination;
    caseId;
    runId;
    digest = createHash('sha256');
    count = 0;
    bytes = 0;
    configured = false;
    configure(args = {}) {
        if (this.configured)
            return;
        const rawRoot = args.debugEvidenceRoot ?? process.env.RUYI_MCP_DEBUG_EVIDENCE_ROOT;
        if (!rawRoot)
            return;
        const rootCheck = resolveSafeOutputPath(rawRoot, 'debugEvidenceRoot', 'directory');
        if (!rootCheck.ok)
            throw new Error(rootCheck.errorMessage);
        const root = realpathSync(rootCheck.resolved);
        if (!statSync(root).isDirectory())
            throw new Error('debugEvidenceRoot must be an existing directory');
        const caseId = String(args.debugCaseId ?? process.env.RUYI_MCP_DEBUG_CASE_ID ?? basename(root)).toLowerCase();
        const runId = String(args.debugRunId ?? `debug_${randomUUID().replaceAll('-', '')}`).toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(caseId))
            throw new Error('Invalid debugCaseId');
        if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(runId))
            throw new Error('Invalid debugRunId');
        const destination = resolve(root, 'evidence', 'web', 'ruyi-debug', runId, 'observations.jsonl');
        if (existsSync(destination))
            throw new Error('Debugger evidence run already exists');
        mkdirSync(dirname(destination), { recursive: true });
        const actualDirectory = realpathSync(dirname(destination));
        const local = relative(root, actualDirectory);
        if (local === '..' || local.startsWith(`..${sep}`))
            throw new Error('Debugger evidence escaped workspace');
        this.destination = destination;
        this.caseId = caseId;
        this.runId = runId;
        this.configured = true;
    }
    record(action, payload) {
        if (!this.destination)
            return;
        if (this.count >= 10000)
            throw new Error('Debugger evidence record limit reached');
        const serialized = JSON.stringify(payload) ?? 'null';
        const object = payload && typeof payload === 'object' ? payload : {};
        const metadata = {
            payloadSha256: createHash('sha256').update(serialized).digest('hex'),
            payloadBytes: Buffer.byteLength(serialized, 'utf8'),
            valueType: Array.isArray(payload) ? 'array' : typeof payload,
        };
        for (const key of ['targetId', 'pauseId', 'breakpointId', 'mode', 'started', 'paused', 'line', 'column', 'truncated', 'totalLength']) {
            const value = object[key];
            if (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)))
                metadata[key] = value;
        }
        const record = `${JSON.stringify({ schema: 'ruyi-debug-observation.v1', recordedAt: new Date().toISOString(), action: action.replace(/[^a-z0-9._-]/g, '_').slice(0, 80), payload: metadata })}\n`;
        appendFileSync(this.destination, record, { encoding: 'utf8', flag: this.count === 0 ? 'wx' : 'a' });
        this.digest.update(record, 'utf8');
        this.bytes += Buffer.byteLength(record, 'utf8');
        this.count++;
        return this.pointer();
    }
    pointer() {
        if (!this.count)
            return;
        return {
            schema: 'ruyi-debug-pointer.v1', caseId: this.caseId, plane: 'ruyi-debug', runId: this.runId,
            artifactId: 'debug-observations', path: `evidence/web/ruyi-debug/${this.runId}/observations.jsonl`,
            sha256: this.digest.copy().digest('hex'), bytes: this.bytes, mediaType: 'application/jsonl', recordCount: this.count,
            sensitivity: 'private-redacted', redaction: 'allowlist-summary',
        };
    }
}
//# sourceMappingURL=debug-evidence.js.map