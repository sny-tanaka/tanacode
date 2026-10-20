// scripts/demo-tour-evidence.mjs の型（単体テスト（test/renderer/demo-trace.test.ts）が、足あとの控えを読み込むため）
export declare const EVIDENCE_TIMEOUT_MS: number;
export declare function within<T, F = null>(promise: Promise<T>, fallback?: F): Promise<T | F>;
export declare function snapshot(): unknown;
export declare const TRACE_QUERY: string;
export declare const TRACE_PREFIX: string;
export declare const TRACE_SHOWN: number;
export declare function traceLog(): { add(text: string): boolean; freeze(): void; lines(): string[] };
