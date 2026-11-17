/** Quote-aware shell substitution discovery for lookout command parsing. */
export interface SubstitutionClause {
    text: string;
    index: number;
}
export declare function decodeAnsiCQuote(value: string): string;
export declare function findNestedSubstitutions(clauses: readonly SubstitutionClause[]): Array<{
    text: string;
    index: number;
}>;
//# sourceMappingURL=substitution-parser.d.ts.map