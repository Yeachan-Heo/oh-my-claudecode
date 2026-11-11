export interface DevContainerContext {
    containerId: string;
    hostWorkspaceRoot: string;
    containerWorkspaceRoot: string;
    configFilePath?: string;
}
export declare function resolveDevContainerContext(workspaceRoot: string): DevContainerContext | null;
export declare function hostPathToContainerPath(filePath: string, context: DevContainerContext | null | undefined): string;
export declare function containerPathToHostPath(filePath: string, context: DevContainerContext | null | undefined): string;
export declare function hostUriToContainerUri(uri: string, context: DevContainerContext | null | undefined): string;
export declare function containerUriToHostUri(uri: string, context: DevContainerContext | null | undefined): string;
//# sourceMappingURL=devcontainer.d.ts.map