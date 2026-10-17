/**
 * Build a commander option parser that accepts only whole numbers in [min, max].
 * `parseInt` alone turns `abc` into NaN and `5x` into 5, which downstream code
 * silently treats as "no limit", "no matches" or the default.
 */
export declare function integerOption(min: number, max?: number): (value: string) => number;
//# sourceMappingURL=integer-option.d.ts.map