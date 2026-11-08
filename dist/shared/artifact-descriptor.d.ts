export declare const DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES = 2048;
export type ArtifactRetention = 'ephemeral' | 'session' | 'until-completion' | 'persistent';
export interface ArtifactProducer {
    system: 'omc' | 'omx';
    component: string;
    worker?: string;
}
export interface ArtifactDescriptor {
    kind: string;
    path: string;
    contentHash?: string;
    createdAt: string;
    producer: ArtifactProducer;
    sizeBytes?: number;
    retention: ArtifactRetention;
    expiresAt?: string;
}
export interface InlineArtifactHandoff {
    mode: 'inline';
    body: string;
    summary: string;
    sizeBytes: number;
    thresholdBytes: number;
}
export interface DescriptorArtifactHandoff {
    mode: 'descriptor';
    summary: string;
    descriptor: ArtifactDescriptor;
    sizeBytes: number;
    thresholdBytes: number;
}
export type ArtifactHandoff = InlineArtifactHandoff | DescriptorArtifactHandoff;
export interface CreateArtifactDescriptorOptions {
    kind: string;
    producer: ArtifactProducer;
    retention: ArtifactRetention;
    createdAt?: string;
    expiresAt?: string;
}
export interface WriteTextArtifactOptions extends CreateArtifactDescriptorOptions {
    path: string;
    content: string;
}
export interface CreateArtifactHandoffOptions {
    body: string;
    summary?: string;
    thresholdBytes?: number;
    descriptorFactory: () => ArtifactDescriptor;
}
export declare function summarizeArtifactBody(body: string, maxChars?: number): string;
export declare function createArtifactDescriptorFromPath(path: string, options: CreateArtifactDescriptorOptions): ArtifactDescriptor;
export declare function writeTextArtifact(options: WriteTextArtifactOptions): ArtifactDescriptor;
export declare function createArtifactHandoff(options: CreateArtifactHandoffOptions): ArtifactHandoff;
//# sourceMappingURL=artifact-descriptor.d.ts.map