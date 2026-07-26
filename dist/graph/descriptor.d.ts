import type { GraphDescriptor, GraphDescriptorInput, SealedGraphDescriptor } from './types.js';
export declare class GraphDescriptorValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function canonicalJson(value: unknown): string;
export declare function computeDescriptorHash(input: GraphDescriptorInput): string;
export declare function verifyDescriptorHash(input: GraphDescriptorInput): input is SealedGraphDescriptor;
export declare function validateGraphDescriptor(descriptor: GraphDescriptor): GraphDescriptor;
export declare function parseGraphDescriptor(input: unknown): GraphDescriptor;
export declare function sealGraphDescriptor(input: unknown): SealedGraphDescriptor;
//# sourceMappingURL=descriptor.d.ts.map