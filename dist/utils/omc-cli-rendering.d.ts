export interface OmcCliRenderOptions {
    env?: NodeJS.ProcessEnv;
    omcAvailable?: boolean;
}
export declare function resolveOmcCliPrefix(options?: OmcCliRenderOptions): string;
export declare function formatOmcCliInvocation(commandSuffix: string, options?: OmcCliRenderOptions): string;
export declare function rewriteOmcCliInvocations(text: string, options?: OmcCliRenderOptions): string;
//# sourceMappingURL=omc-cli-rendering.d.ts.map