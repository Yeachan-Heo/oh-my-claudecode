/**
 * Escape regex metacharacters so a string matches literally inside new RegExp().
 *
 * Replaces all special regex characters with their escaped equivalents:
 * . * + ? ^ $ { } ( ) | [ ] \
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
