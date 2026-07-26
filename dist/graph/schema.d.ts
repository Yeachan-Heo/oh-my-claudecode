import { z } from 'zod';
import type { GraphDescriptor, GraphEvidenceReference, GraphNodeResult } from './types.js';
export declare const graphEffectPolicySchema: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
    policy: z.ZodLiteral<"side_effect_free">;
}, "strict", z.ZodTypeAny, {
    policy: "side_effect_free";
}, {
    policy: "side_effect_free";
}>, z.ZodObject<{
    policy: z.ZodLiteral<"idempotent">;
    idempotency_key_template: z.ZodString;
}, "strict", z.ZodTypeAny, {
    policy: "idempotent";
    idempotency_key_template: string;
}, {
    policy: "idempotent";
    idempotency_key_template: string;
}>, z.ZodObject<{
    policy: z.ZodLiteral<"reconcile">;
}, "strict", z.ZodTypeAny, {
    policy: "reconcile";
}, {
    policy: "reconcile";
}>]>;
export declare const graphAgentNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"agent">;
    instructions: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, "strict", z.ZodTypeAny, {
        policy: "side_effect_free";
    }, {
        policy: "side_effect_free";
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        policy: "idempotent";
        idempotency_key_template: string;
    }, {
        policy: "idempotent";
        idempotency_key_template: string;
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, "strict", z.ZodTypeAny, {
        policy: "reconcile";
    }, {
        policy: "reconcile";
    }>]>;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    id: string;
    kind: "agent";
    instructions: string;
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}, {
    title: string;
    id: string;
    kind: "agent";
    instructions: string;
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}>;
export declare const graphCommandNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"command">;
    command: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, "strict", z.ZodTypeAny, {
        policy: "side_effect_free";
    }, {
        policy: "side_effect_free";
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        policy: "idempotent";
        idempotency_key_template: string;
    }, {
        policy: "idempotent";
        idempotency_key_template: string;
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, "strict", z.ZodTypeAny, {
        policy: "reconcile";
    }, {
        policy: "reconcile";
    }>]>;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    command: string;
    id: string;
    kind: "command";
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}, {
    title: string;
    command: string;
    id: string;
    kind: "command";
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}>;
export declare const graphHumanApprovalNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"human-approval">;
    prompt: z.ZodString;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    prompt: string;
    id: string;
    kind: "human-approval";
}, {
    title: string;
    prompt: string;
    id: string;
    kind: "human-approval";
}>;
export declare const graphJoinNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"join">;
    fan_out_node_id: z.ZodString;
    input_branch_ids: z.ZodArray<z.ZodString, "many">;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    id: string;
    kind: "join";
    fan_out_node_id: string;
    input_branch_ids: string[];
}, {
    title: string;
    id: string;
    kind: "join";
    fan_out_node_id: string;
    input_branch_ids: string[];
}>;
export declare const graphNodeSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"agent">;
    instructions: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, "strict", z.ZodTypeAny, {
        policy: "side_effect_free";
    }, {
        policy: "side_effect_free";
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        policy: "idempotent";
        idempotency_key_template: string;
    }, {
        policy: "idempotent";
        idempotency_key_template: string;
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, "strict", z.ZodTypeAny, {
        policy: "reconcile";
    }, {
        policy: "reconcile";
    }>]>;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    id: string;
    kind: "agent";
    instructions: string;
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}, {
    title: string;
    id: string;
    kind: "agent";
    instructions: string;
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}>, z.ZodObject<{
    kind: z.ZodLiteral<"command">;
    command: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, "strict", z.ZodTypeAny, {
        policy: "side_effect_free";
    }, {
        policy: "side_effect_free";
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        policy: "idempotent";
        idempotency_key_template: string;
    }, {
        policy: "idempotent";
        idempotency_key_template: string;
    }>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, "strict", z.ZodTypeAny, {
        policy: "reconcile";
    }, {
        policy: "reconcile";
    }>]>;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    command: string;
    id: string;
    kind: "command";
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}, {
    title: string;
    command: string;
    id: string;
    kind: "command";
    timeout_ms: number;
    max_attempts: number;
    effect_policy: {
        policy: "side_effect_free";
    } | {
        policy: "idempotent";
        idempotency_key_template: string;
    } | {
        policy: "reconcile";
    };
}>, z.ZodObject<{
    kind: z.ZodLiteral<"human-approval">;
    prompt: z.ZodString;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    prompt: string;
    id: string;
    kind: "human-approval";
}, {
    title: string;
    prompt: string;
    id: string;
    kind: "human-approval";
}>, z.ZodObject<{
    kind: z.ZodLiteral<"join">;
    fan_out_node_id: z.ZodString;
    input_branch_ids: z.ZodArray<z.ZodString, "many">;
    id: z.ZodString;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    title: string;
    id: string;
    kind: "join";
    fan_out_node_id: string;
    input_branch_ids: string[];
}, {
    title: string;
    id: string;
    kind: "join";
    fan_out_node_id: string;
    input_branch_ids: string[];
}>]>;
export declare const graphFixedEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"fixed">;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "fixed";
    from: string;
    to: string;
}, {
    id: string;
    kind: "fixed";
    from: string;
    to: string;
}>;
export declare const graphConditionalEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"conditional">;
    route: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "conditional";
    from: string;
    to: string;
    route: string;
}, {
    id: string;
    kind: "conditional";
    from: string;
    to: string;
    route: string;
}>;
export declare const graphFanOutEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"fan_out">;
    branch_id: z.ZodString;
    owner_join_id: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "fan_out";
    from: string;
    to: string;
    branch_id: string;
    owner_join_id: string;
}, {
    id: string;
    kind: "fan_out";
    from: string;
    to: string;
    branch_id: string;
    owner_join_id: string;
}>;
export declare const graphBackEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"back_edge">;
    route: z.ZodString;
    max_traversals: z.ZodNumber;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "back_edge";
    from: string;
    to: string;
    route: string;
    max_traversals: number;
}, {
    id: string;
    kind: "back_edge";
    from: string;
    to: string;
    route: string;
    max_traversals: number;
}>;
export declare const graphEdgeSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"fixed">;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "fixed";
    from: string;
    to: string;
}, {
    id: string;
    kind: "fixed";
    from: string;
    to: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"conditional">;
    route: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "conditional";
    from: string;
    to: string;
    route: string;
}, {
    id: string;
    kind: "conditional";
    from: string;
    to: string;
    route: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"fan_out">;
    branch_id: z.ZodString;
    owner_join_id: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "fan_out";
    from: string;
    to: string;
    branch_id: string;
    owner_join_id: string;
}, {
    id: string;
    kind: "fan_out";
    from: string;
    to: string;
    branch_id: string;
    owner_join_id: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"back_edge">;
    route: z.ZodString;
    max_traversals: z.ZodNumber;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    kind: "back_edge";
    from: string;
    to: string;
    route: string;
    max_traversals: number;
}, {
    id: string;
    kind: "back_edge";
    from: string;
    to: string;
    route: string;
    max_traversals: number;
}>]>;
export declare const graphDescriptorSchema: z.ZodObject<{
    descriptor_version: z.ZodLiteral<1>;
    run_id: z.ZodString;
    revision_id: z.ZodString;
    goal: z.ZodString;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"agent">;
        instructions: z.ZodString;
        timeout_ms: z.ZodNumber;
        max_attempts: z.ZodNumber;
        effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
            policy: z.ZodLiteral<"side_effect_free">;
        }, "strict", z.ZodTypeAny, {
            policy: "side_effect_free";
        }, {
            policy: "side_effect_free";
        }>, z.ZodObject<{
            policy: z.ZodLiteral<"idempotent">;
            idempotency_key_template: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            policy: "idempotent";
            idempotency_key_template: string;
        }, {
            policy: "idempotent";
            idempotency_key_template: string;
        }>, z.ZodObject<{
            policy: z.ZodLiteral<"reconcile">;
        }, "strict", z.ZodTypeAny, {
            policy: "reconcile";
        }, {
            policy: "reconcile";
        }>]>;
        id: z.ZodString;
        title: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        title: string;
        id: string;
        kind: "agent";
        instructions: string;
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    }, {
        title: string;
        id: string;
        kind: "agent";
        instructions: string;
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"command">;
        command: z.ZodString;
        timeout_ms: z.ZodNumber;
        max_attempts: z.ZodNumber;
        effect_policy: z.ZodDiscriminatedUnion<"policy", [z.ZodObject<{
            policy: z.ZodLiteral<"side_effect_free">;
        }, "strict", z.ZodTypeAny, {
            policy: "side_effect_free";
        }, {
            policy: "side_effect_free";
        }>, z.ZodObject<{
            policy: z.ZodLiteral<"idempotent">;
            idempotency_key_template: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            policy: "idempotent";
            idempotency_key_template: string;
        }, {
            policy: "idempotent";
            idempotency_key_template: string;
        }>, z.ZodObject<{
            policy: z.ZodLiteral<"reconcile">;
        }, "strict", z.ZodTypeAny, {
            policy: "reconcile";
        }, {
            policy: "reconcile";
        }>]>;
        id: z.ZodString;
        title: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        title: string;
        command: string;
        id: string;
        kind: "command";
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    }, {
        title: string;
        command: string;
        id: string;
        kind: "command";
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"human-approval">;
        prompt: z.ZodString;
        id: z.ZodString;
        title: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        title: string;
        prompt: string;
        id: string;
        kind: "human-approval";
    }, {
        title: string;
        prompt: string;
        id: string;
        kind: "human-approval";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"join">;
        fan_out_node_id: z.ZodString;
        input_branch_ids: z.ZodArray<z.ZodString, "many">;
        id: z.ZodString;
        title: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        title: string;
        id: string;
        kind: "join";
        fan_out_node_id: string;
        input_branch_ids: string[];
    }, {
        title: string;
        id: string;
        kind: "join";
        fan_out_node_id: string;
        input_branch_ids: string[];
    }>]>, "many">;
    edges: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"fixed">;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        id: string;
        kind: "fixed";
        from: string;
        to: string;
    }, {
        id: string;
        kind: "fixed";
        from: string;
        to: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"conditional">;
        route: z.ZodString;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        id: string;
        kind: "conditional";
        from: string;
        to: string;
        route: string;
    }, {
        id: string;
        kind: "conditional";
        from: string;
        to: string;
        route: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"fan_out">;
        branch_id: z.ZodString;
        owner_join_id: z.ZodString;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        id: string;
        kind: "fan_out";
        from: string;
        to: string;
        branch_id: string;
        owner_join_id: string;
    }, {
        id: string;
        kind: "fan_out";
        from: string;
        to: string;
        branch_id: string;
        owner_join_id: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"back_edge">;
        route: z.ZodString;
        max_traversals: z.ZodNumber;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        id: string;
        kind: "back_edge";
        from: string;
        to: string;
        route: string;
        max_traversals: number;
    }, {
        id: string;
        kind: "back_edge";
        from: string;
        to: string;
        route: string;
        max_traversals: number;
    }>]>, "many">;
    entry_node_ids: z.ZodArray<z.ZodString, "many">;
    concurrency_limit: z.ZodNumber;
    terminal_verification_node_id: z.ZodString;
    descriptor_hash: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    descriptor_version: 1;
    run_id: string;
    revision_id: string;
    goal: string;
    nodes: ({
        title: string;
        id: string;
        kind: "agent";
        instructions: string;
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    } | {
        title: string;
        command: string;
        id: string;
        kind: "command";
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    } | {
        title: string;
        prompt: string;
        id: string;
        kind: "human-approval";
    } | {
        title: string;
        id: string;
        kind: "join";
        fan_out_node_id: string;
        input_branch_ids: string[];
    })[];
    edges: ({
        id: string;
        kind: "fixed";
        from: string;
        to: string;
    } | {
        id: string;
        kind: "conditional";
        from: string;
        to: string;
        route: string;
    } | {
        id: string;
        kind: "fan_out";
        from: string;
        to: string;
        branch_id: string;
        owner_join_id: string;
    } | {
        id: string;
        kind: "back_edge";
        from: string;
        to: string;
        route: string;
        max_traversals: number;
    })[];
    entry_node_ids: string[];
    concurrency_limit: number;
    terminal_verification_node_id: string;
    descriptor_hash?: string | undefined;
}, {
    descriptor_version: 1;
    run_id: string;
    revision_id: string;
    goal: string;
    nodes: ({
        title: string;
        id: string;
        kind: "agent";
        instructions: string;
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    } | {
        title: string;
        command: string;
        id: string;
        kind: "command";
        timeout_ms: number;
        max_attempts: number;
        effect_policy: {
            policy: "side_effect_free";
        } | {
            policy: "idempotent";
            idempotency_key_template: string;
        } | {
            policy: "reconcile";
        };
    } | {
        title: string;
        prompt: string;
        id: string;
        kind: "human-approval";
    } | {
        title: string;
        id: string;
        kind: "join";
        fan_out_node_id: string;
        input_branch_ids: string[];
    })[];
    edges: ({
        id: string;
        kind: "fixed";
        from: string;
        to: string;
    } | {
        id: string;
        kind: "conditional";
        from: string;
        to: string;
        route: string;
    } | {
        id: string;
        kind: "fan_out";
        from: string;
        to: string;
        branch_id: string;
        owner_join_id: string;
    } | {
        id: string;
        kind: "back_edge";
        from: string;
        to: string;
        route: string;
        max_traversals: number;
    })[];
    entry_node_ids: string[];
    concurrency_limit: number;
    terminal_verification_node_id: string;
    descriptor_hash?: string | undefined;
}>;
export declare const graphEvidenceReferenceSchema: z.ZodObject<{
    kind: z.ZodEnum<["file", "command", "test", "human", "url"]>;
    ref: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    kind: "file" | "command" | "test" | "human" | "url";
    ref: string;
    summary?: string | undefined;
}, {
    kind: "file" | "command" | "test" | "human" | "url";
    ref: string;
    summary?: string | undefined;
}>;
export declare const graphNodeResultSchema: z.ZodObject<{
    outcome: z.ZodEnum<["succeeded", "failed"]>;
    attempt_id: z.ZodString;
    route: z.ZodOptional<z.ZodString>;
    output_summary: z.ZodOptional<z.ZodString>;
    evidence_refs: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<["file", "command", "test", "human", "url"]>;
        ref: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        kind: "file" | "command" | "test" | "human" | "url";
        ref: string;
        summary?: string | undefined;
    }, {
        kind: "file" | "command" | "test" | "human" | "url";
        ref: string;
        summary?: string | undefined;
    }>, "many">;
    external_idempotency_key: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    outcome: "failed" | "succeeded";
    attempt_id: string;
    evidence_refs: {
        kind: "file" | "command" | "test" | "human" | "url";
        ref: string;
        summary?: string | undefined;
    }[];
    route?: string | undefined;
    output_summary?: string | undefined;
    external_idempotency_key?: string | undefined;
}, {
    outcome: "failed" | "succeeded";
    attempt_id: string;
    evidence_refs: {
        kind: "file" | "command" | "test" | "human" | "url";
        ref: string;
        summary?: string | undefined;
    }[];
    route?: string | undefined;
    output_summary?: string | undefined;
    external_idempotency_key?: string | undefined;
}>;
export declare function parseGraphDescriptorShape(input: unknown): GraphDescriptor;
export declare function parseGraphNodeResult(input: unknown): GraphNodeResult;
export declare function parseGraphEvidenceReference(input: unknown): GraphEvidenceReference;
//# sourceMappingURL=schema.d.ts.map