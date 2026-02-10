export interface TableColumn {
    header: string;
    field: string;
    width: number;
    align?: 'left' | 'right' | 'center';
    format?: (value: any) => string;
}
export declare function renderTable(data: any[], columns: TableColumn[]): string;
export declare const colors: {
    red: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    blue: (text: string) => string;
    magenta: (text: string) => string;
    cyan: (text: string) => string;
    gray: (text: string) => string;
    bold: (text: string) => string;
};
export declare function formatCostWithColor(cost: number): string;
export declare function formatTokenCount(tokens: number): string;
export declare function formatDuration(ms: number): string;
//# sourceMappingURL=formatting.d.ts.map