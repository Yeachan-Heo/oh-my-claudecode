/**
 * Parse JSONL text, skipping blank and unparseable lines (e.g. a line torn by
 * a crash mid-append) so one bad line does not hide the rest.
 */
export function parseJsonLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      continue;
    }
  }
  return out;
}
