/**
 * Zero-dependency Jev client (TypeSafe System One).
 *
 * POSTs {state, questions, model:"jev-latest"} with bearer auth and an
 * AbortController timeout. No retry — the interactive path degrades instead.
 * Throws JevClientError on any failure; the resolver catches and degrades.
 */
import type { JevQuestionDef, JevQuestions, JevResponse } from './types.js';
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
/** A question as the API accepts it: `score` carries an ordered criteria list. */
type WireQuestion = Omit<JevQuestionDef, 'criteria'> & {
    criteria: Record<string, string> | string[];
};
/**
 * Map authored questions onto the wire schema. Criteria are authored as a
 * named map for readability, but `score` questions are rejected with HTTP 422
 * (`Input should be a valid list`) unless the criteria are an ordered list of
 * descriptions from low to high; the answer legend then comes back keyed by
 * index. `choice` and `noul` take the map unchanged.
 */
export declare function serializeQuestions(questions: JevQuestions): Record<string, WireQuestion>;
/**
 * Minimal response validation: object with a non-empty `answers` dict whose
 * entries are objects with a string `type`. Throws JevClientError otherwise.
 */
export declare function validateJevResponse(body: unknown): JevResponse;
export {};
//# sourceMappingURL=client.d.ts.map