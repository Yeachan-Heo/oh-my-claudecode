/**
 * Shape check of the provider reading of the panel quota wait. Every field that decides whether a pane may be
 * resumed (unit, percentage, reset time) is checked here, once, before the plan looks at it: a reading with a
 * mistyped field is not a reading, so it cannot authorize a resume (a weekly unit sent as the text "6" would
 * otherwise slip past the strict comparison with the weekly unit code).
 */
import { z } from 'zod';
declare const QuotaLimitSchema: z.ZodObject<{
    unit: z.ZodOptional<z.ZodNumber>;
    percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    nextResetTime: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    unit: z.ZodOptional<z.ZodNumber>;
    percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    nextResetTime: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    unit: z.ZodOptional<z.ZodNumber>;
    percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    nextResetTime: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.ZodTypeAny, "passthrough">>;
export type QuotaLimit = z.infer<typeof QuotaLimitSchema>;
/**
 * The limits of a reading body (`data.limits`, or a bare array of limits), or null when the body has none or any
 * limit has a field of the wrong type. One bad limit rejects the whole reading: the plan must not decide on the rest.
 */
export declare function parseQuotaLimits(body: unknown): QuotaLimit[] | null;
export {};
//# sourceMappingURL=panel-quota-limits.d.ts.map