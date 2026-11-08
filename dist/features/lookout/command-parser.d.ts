export interface CollectedMatch {
    snippet: string;
    index: number;
}
export interface CommandToken {
    value: string;
    index: number;
    quoted: boolean;
    raw: string;
}
export declare function tokenizeCommand(segment: string): CommandToken[];
export declare function splitCommandClauses(line: string): Array<{
    text: string;
    index: number;
}>;
export declare function findExecutableIndex(tokens: CommandToken[], executable: string): number;
export declare function addMatch(hits: CollectedMatch[], snippet: string, index: number): void;
export declare function collectForceOps(line: string, depth?: number): CollectedMatch[];
export declare function collectProtectedPushDests(line: string, depth?: number): CollectedMatch[];
//# sourceMappingURL=command-parser.d.ts.map