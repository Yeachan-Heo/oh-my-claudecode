/** Remove one or more trailing forward slashes without otherwise normalizing the value. */
export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
