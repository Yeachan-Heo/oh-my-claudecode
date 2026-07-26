import { z } from 'zod';
const idSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a stable identifier');
const textSchema = z.string().min(1).max(32_768);
const sideEffectFreeSchema = z.object({ policy: z.literal('side_effect_free') }).strict();
const idempotentSchema = z
    .object({
    policy: z.literal('idempotent'),
    idempotency_key_template: z.string().min(1).max(512),
})
    .strict();
const reconcileSchema = z.object({ policy: z.literal('reconcile') }).strict();
export const graphEffectPolicySchema = z.discriminatedUnion('policy', [
    sideEffectFreeSchema,
    idempotentSchema,
    reconcileSchema,
]);
const nodeBase = {
    id: idSchema,
    title: z.string().min(1).max(256),
};
const executableNodeBase = {
    ...nodeBase,
    timeout_ms: z.number().int().min(100).max(86_400_000),
    max_attempts: z.number().int().min(1).max(20),
    effect_policy: graphEffectPolicySchema,
};
export const graphAgentNodeSchema = z
    .object({
    ...executableNodeBase,
    kind: z.literal('agent'),
    instructions: textSchema,
})
    .strict();
export const graphCommandNodeSchema = z
    .object({
    ...executableNodeBase,
    kind: z.literal('command'),
    command: textSchema,
})
    .strict();
export const graphHumanApprovalNodeSchema = z
    .object({
    ...nodeBase,
    kind: z.literal('human-approval'),
    prompt: textSchema,
})
    .strict();
export const graphJoinNodeSchema = z
    .object({
    ...nodeBase,
    kind: z.literal('join'),
    fan_out_node_id: idSchema,
    input_branch_ids: z.array(idSchema).min(2).max(64),
})
    .strict();
export const graphNodeSchema = z.discriminatedUnion('kind', [
    graphAgentNodeSchema,
    graphCommandNodeSchema,
    graphHumanApprovalNodeSchema,
    graphJoinNodeSchema,
]);
const edgeBase = { id: idSchema, from: idSchema, to: idSchema };
export const graphFixedEdgeSchema = z.object({ ...edgeBase, kind: z.literal('fixed') }).strict();
export const graphConditionalEdgeSchema = z
    .object({ ...edgeBase, kind: z.literal('conditional'), route: idSchema })
    .strict();
export const graphFanOutEdgeSchema = z
    .object({
    ...edgeBase,
    kind: z.literal('fan_out'),
    branch_id: idSchema,
    owner_join_id: idSchema,
})
    .strict();
export const graphBackEdgeSchema = z
    .object({
    ...edgeBase,
    kind: z.literal('back_edge'),
    route: idSchema,
    max_traversals: z.number().int().min(1).max(100),
})
    .strict();
export const graphEdgeSchema = z.discriminatedUnion('kind', [
    graphFixedEdgeSchema,
    graphConditionalEdgeSchema,
    graphFanOutEdgeSchema,
    graphBackEdgeSchema,
]);
export const graphDescriptorSchema = z
    .object({
    descriptor_version: z.literal(1),
    run_id: idSchema,
    revision_id: idSchema,
    goal: textSchema,
    nodes: z.array(graphNodeSchema).min(1).max(1_000),
    edges: z.array(graphEdgeSchema).max(5_000),
    entry_node_ids: z.array(idSchema).min(1).max(64),
    concurrency_limit: z.number().int().min(1).max(64),
    terminal_verification_node_id: idSchema,
    descriptor_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
    .strict();
export const graphEvidenceReferenceSchema = z
    .object({
    kind: z.enum(['file', 'command', 'test', 'human', 'url']),
    ref: z.string().min(1).max(2_048),
    summary: z.string().max(2_048).optional(),
})
    .strict();
export const graphNodeResultSchema = z
    .object({
    outcome: z.enum(['succeeded', 'failed']),
    attempt_id: idSchema,
    route: idSchema.optional(),
    output_summary: z.string().max(8_192).optional(),
    evidence_refs: z.array(graphEvidenceReferenceSchema).max(64),
    external_idempotency_key: z.string().min(1).max(512).optional(),
})
    .strict();
export function parseGraphDescriptorShape(input) {
    return graphDescriptorSchema.parse(input);
}
export function parseGraphNodeResult(input) {
    return graphNodeResultSchema.parse(input);
}
export function parseGraphEvidenceReference(input) {
    return graphEvidenceReferenceSchema.parse(input);
}
//# sourceMappingURL=schema.js.map