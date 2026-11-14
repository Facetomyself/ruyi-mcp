export declare class AsyncSourceMaps {
    private worker?;
    private sequence;
    private pending;
    private call;
    load(input: unknown): Promise<any>;
    generated(mapId: string, source: string, line: number, column: number): Promise<any>;
    original(mapId: string, line: number, column: number): Promise<any>;
    content(mapId: string, source: string): Promise<any>;
    clear(reason?: Error): void;
}
