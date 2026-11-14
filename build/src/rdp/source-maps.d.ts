import { type TraceMap } from '@jridgewell/trace-mapping';
interface MapRecord {
    map: TraceMap;
    hash: string;
    sourceHash: string;
    sourceActor: string;
    url: string;
}
export declare class SourceMaps {
    private maps;
    clear(): void;
    load(input: {
        sourceActor: string;
        source: string;
        map?: unknown;
        path?: string;
        url?: string;
        allowRemote?: boolean;
    }): Promise<Record<string, unknown>>;
    get(mapId: string): MapRecord;
    generated(mapId: string, source: string, line: number, column?: number): Record<string, unknown>;
    original(mapId: string, line: number, column: number): unknown;
    content(mapId: string, source: string): string | null;
}
export {};
