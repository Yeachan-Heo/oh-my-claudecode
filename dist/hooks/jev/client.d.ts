/**
 * Zero-dependency Jev client (TypeSafe System One).
 *
 * POSTs {state, questions, model:"jev-latest"} with bearer auth and an
 * AbortController timeout. No retry — the interactive path degrades instead.
 * Throws JevClientError on any failure; the resolver catches and degrades.
 */
import type { JevAnswer, JevQuestionDef, JevQuestions, JevResponse } from './types.js';
/** What a failed request tells about the endpoint (read by the opt-in shared breaker). */
export interface JevFailureDetails {
    /** HTTP status of a non-2xx response. */
    status?: number;
    /** Retry-After header of that response. */
    retryAfter?: string;
    /** Start of the body of a 429 response, read only when JevClientOptions.bodyForRetry asked for it. */
    body?: string;
    /** No HTTP response arrived at all: timeout or network error. */
    noResponse?: boolean;
}
export declare class JevClientError extends Error {
    readonly status?: number;
    readonly retryAfter?: string;
    readonly body?: string;
    readonly noResponse?: boolean;
    constructor(message: string, details?: JevFailureDetails);
}
export interface JevClientOptions {
    endpoint: string;
    apiKey: string;
    timeoutMs: number;
    /**
     * Opt-in shared breaker: for a 429, called with the Retry-After header; when it
     * returns { maxChars }, that many characters of the response body are read
     * (the breaker takes a retry time from them). Without it no body is read.
     */
    bodyForRetry?: (retryAfter: string | undefined) => {
        maxChars: number;
    } | undefined;
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
/** A Noul probability at or above this value reads as "yes". */
export declare const NOUL_YES_THRESHOLD = 0.5;
/**
 * Read a Noul answer as yes/no. The API returns `noul` as the probability of
 * "yes" (0-1), not as a boolean, so `noul === true` never matches a real
 * answer. A boolean is still accepted; a missing or non-finite value reads as
 * "no". Same rule as jevSaysTaskComplete() in scripts/persistent-mode.mjs.
 */
export declare function noulAnswerIsYes(answer: JevAnswer | undefined): boolean;
export {};
//# sourceMappingURL=client.d.ts.map