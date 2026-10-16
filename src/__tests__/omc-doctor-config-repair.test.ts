import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('doctor canonical config repair', () => {
  it('routes doctor CLAUDE repairs through canonical global preserve only', () => {
    const doctor = readFileSync(join(process.cwd(), 'skills/omc-doctor/SKILL.md'), 'utf-8');
    const block = doctor.split('### Fix: Missing/Outdated CLAUDE.md')[1].split('### Fix: Legacy Curl-Installed Content')[0];
    expect(block).toContain('${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-claude-md.sh" global preserve');
    expect(block).not.toContain('WebFetch(');
    expect(block).not.toContain('raw.githubusercontent.com');
    expect(block).toContain('stop and leave the files unchanged');
  });
});
