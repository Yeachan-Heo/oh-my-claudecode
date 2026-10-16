import { InvalidArgumentError } from 'commander';

/**
 * Build a commander option parser that accepts only whole numbers in [min, max].
 * `parseInt` alone turns `abc` into NaN and `5x` into 5, which downstream code
 * silently treats as "no limit", "no matches" or the default.
 */
export function integerOption(min: number, max: number = Number.MAX_SAFE_INTEGER): (value: string) => number {
  return (value: string): number => {
    const normalized = value.trim();
    const parsed = Number(normalized);
    if (!/^[+-]?\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(
        max === Number.MAX_SAFE_INTEGER ? `must be an integer of at least ${min}` : `must be an integer between ${min} and ${max}`,
      );
    }
    return parsed;
  };
}
