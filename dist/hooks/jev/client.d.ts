/**
 * Zero-dependency Jev client (TypeSafe System One).
 *
 * POSTs {state, questions, model:"jev-latest"} with bearer auth and an
 * AbortController timeout. No retry — the interactive path degrades instead.
 * Throws JevClientError on any failure; the resolver catches and degrades.
 */
import type { JevQuestions, JevResponse } from './types.js';
export declare class JevClientError extends Error {
    constructor(message: string);
}
export interface JevClientOptions {
    endpoint: string;
    apiKey: string;
    timeoutMs: number;
    /** Test hook: injected transport. Defaults to globalThis.fetch. */
    fetchFn?: typeof fetch;
}
export declare function queryJev(state: unknown, questions: JevQuestions, options: JevClientOptions): Promise<JevResponse>;
export declare const JEV_MODEL = "jev-latest";
/**
 * Minimal response validation: object with a non-empty `answers` dict whose
 * entries are objects with a string `type`. Throws JevClientError otherwise.
 */
export declare function validateJevResponse(body: unknown): JevResponse;
//# sourceMappingURL=client.d.ts.map