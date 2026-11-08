import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

describe('bridge/cli.cjs help-question regex regression (#2482)', () => {
  it('keeps escaped help-question regex sequences intact in the baked bridge artifact', () => {
    const source = readFileSync(join(REPO_ROOT, 'bridge', 'cli.cjs'), 'utf-8');
    const marker = 'const helpQuestionPatterns = [';
    const start = source.indexOf(marker);
    const snippet = start === -1 ? '' : source.slice(start, start + 260);

    expect(snippet).toContain("\\\\bhow\\\\s+do\\\\s+i\\\\s+use\\\\b[^\\\\n]{0,40}\\\\b${escaped}\\\\b");
    expect(snippet).toContain("\\\\bwhat(?:'s|\\\\s+is)\\\\b[^\\\\n]{0,40}\\\\b${escaped}\\\\b[^\\\\n]{0,40}\\\\bhow\\\\s+to\\\\s+use\\\\b");
    expect(snippet).not.toContain("\\bhows+dos+is+use\\b");
    expect(snippet).not.toContain("\\bwhat(?:'s|s+is)\\b");
  });
});
