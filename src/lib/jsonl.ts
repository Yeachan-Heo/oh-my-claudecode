/**
 * Parse JSONL text of object records, skipping blank lines, unparseable lines
 * (e.g. a line torn by a crash mid-append) and lines that parse to a non-object,
 * so one bad line does not hide or break the rest.
 */
export function parseJsonLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.push(value as T);
  }
  return out;
}
