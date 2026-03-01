export { isCliAvailable, validateCliAvailable, getContract, type CliAgentType } from './model-contract.js';
export interface CliInfo {
    available: boolean;
    version?: string;
    path?: string;
}
export declare function detectCli(binary: string): CliInfo;
export declare function detectAllClis(): Record<string, CliInfo>;
//# sourceMappingURL=cli-detection.d.ts.map