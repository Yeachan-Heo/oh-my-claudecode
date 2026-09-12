/** Narrow parser for rm commands targeting conventional test artifacts. */
export interface TestArtifactMatch {
    snippet: string;
    index: number;
}
export declare function collectRmTestArtifacts(line: string, depth?: number): TestArtifactMatch[];
//# sourceMappingURL=test-artifact-parser.d.ts.map