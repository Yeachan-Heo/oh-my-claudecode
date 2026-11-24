/**
 * Parse JSONL text of object records, skipping blank lines, unparseable lines
 * (e.g. a line torn by a crash mid-append) and lines that parse to a non-object,
 * so one bad line does not hide or break the rest.
 */
export declare function parseJsonLines<T>(raw: string): T[];
//# sourceMappingURL=jsonl.d.ts.map