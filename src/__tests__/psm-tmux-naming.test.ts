/**
 * Regression tests for issue #3528:
 * PSM built tmux session names containing colons (`psm:<alias>:<type>-<id>`).
 * tmux reserves ':' and '.' for its `session:window.pane` target syntax and
 * silently rewrites them, so every later has-session / send-keys / list /
 * attach / kill / cleanup and registry lookup missed and sessions were orphaned.
 *
 * The fix introduces ONE canonical tmux-safe naming contract
 * (psm_tmux_safe_name + psm_tmux_name_from_id) applied at every tmux boundary,
 * plus a fail-closed post-create assertion. These tests cover the contract,
 * create, lookup, registration, list, attach, kill/cleanup, status reverse
 * lookup, and the source/docs contract.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PSM_ROOT = join(process.cwd(), 'skills', 'project-session-manager');
const TMUX_SH = join(PSM_ROOT, 'lib', 'tmux.sh');
const SESSION_SH = join(PSM_ROOT, 'lib', 'session.sh');
const CONFIG_SH = join(PSM_ROOT, 'lib', 'config.sh');
const PSM_SH = join(PSM_ROOT, 'psm.sh');
const SKILL_MD = join(PSM_ROOT, 'SKILL.md');

function runShell(script: string, home?: string): string {
  return execFileSync('bash', ['-lc', script], {
    encoding: 'utf-8',
    env: home ? { ...process.env, HOME: home } : { ...process.env },
  }).trim();
}

// A stateful mock tmux: has-session consults a "created" registry file,
// new-session records the exact -s name, kill-session removes it.
const MOCK_TMUX = `
tmux() {
  local sub="$1"; shift
  case "$sub" in
    has-session)
      local name=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-t" ]] && name="$2"; shift; done
      grep -qxF "$name" "$CREATED_FILE" 2>/dev/null ;;
    new-session)
      local name=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-s" ]] && name="$2"; shift; done
      printf '%s\\n' "$name" >> "$CREATED_FILE" ;;
    kill-session)
      local name=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-t" ]] && name="$2"; shift; done
      grep -vxF "$name" "$CREATED_FILE" > "$CREATED_FILE.tmp" 2>/dev/null || true
      mv "$CREATED_FILE.tmp" "$CREATED_FILE" 2>/dev/null || true ;;
    *) : ;;
  esac
}
`;

const SOURCE = `CREATED_FILE=$(mktemp); ${MOCK_TMUX} source "${TMUX_SH}";`;

describe('PSM tmux-safe naming contract (issue #3528)', () => {
  describe('canonical contract', () => {
    it('psm_tmux_safe_name translates both ":" and "."', () => {
      const out = runShell(`${SOURCE} psm_tmux_safe_name "omc:pr-123"; echo; psm_tmux_safe_name "repo.js:feat-a.b"`);
      expect(out).toBe('omc_pr-123\nrepo_js_feat-a_b');
    });

    it('psm_tmux_name_from_id prefixes psm_ and produces no reserved chars', () => {
      const out = runShell(`${SOURCE} psm_tmux_name_from_id "omc:pr-123"`);
      expect(out).toBe('psm_omc_pr-123');
      expect(out).not.toContain(':');
      expect(out).not.toContain('.');
    });

    it('translation is idempotent for already-safe names', () => {
      const out = runShell(`${SOURCE} psm_tmux_safe_name "psm_omc_pr-123"`);
      expect(out).toBe('psm_omc_pr-123');
    });
  });

  describe('create + registration', () => {
    it('creates the session under the tmux-safe name', () => {
      const out = runShell(`${SOURCE} psm_create_tmux_session "psm:omc:pr-123" "/tmp"`);
      expect(out).toBe('created|psm_omc_pr-123');
    });

    it('fail-closed: errors when the session is absent after new-session', () => {
      // Mock where new-session silently drops the name (simulates tmux rewrite miss).
      const failMock = `
tmux() {
  case "$1" in
    has-session) return 1 ;;
    *) return 0 ;;
  esac
}
`;
      const out = runShell(
        `CREATED_FILE=$(mktemp); ${failMock} source "${TMUX_SH}"; psm_create_tmux_session "psm:omc:pr-9" "/tmp" || true`,
      );
      expect(out).toContain('error|tmux session not found after create');
    });
  });

  describe('lookup', () => {
    it('finds a created session whether queried by colon or safe form', () => {
      const out = runShell(
        `${SOURCE} psm_create_tmux_session "psm:omc:pr-123" "/tmp" >/dev/null;` +
          ` psm_tmux_session_exists "psm:omc:pr-123" && echo COLON=yes || echo COLON=no;` +
          ` psm_tmux_session_exists "psm_omc_pr-123" && echo SAFE=yes || echo SAFE=no`,
      );
      expect(out).toBe('COLON=yes\nSAFE=yes');
    });
  });

  describe('list', () => {
    it('greps the tmux-safe psm_ prefix, not psm:', () => {
      const listMock = `
tmux() {
  case "$1" in
    list-sessions) printf 'psm_omc_pr-1|100|0\\nother|101|0\\n' ;;
    *) : ;;
  esac
}
`;
      const out = runShell(`CREATED_FILE=$(mktemp); ${listMock} source "${TMUX_SH}"; psm_list_tmux_sessions`);
      expect(out).toBe('psm_omc_pr-1|100|0');
    });
  });

  describe('attach', () => {
    it('psm_tmux_session_name helper emits the tmux-safe form', () => {
      const out = runShell(`${SOURCE} psm_tmux_session_name "omc" "pr" "123"`);
      expect(out).toBe('psm_omc_pr-123');
    });
  });

  describe('kill / cleanup', () => {
    it('kills the session addressed by its public (colon) id', () => {
      const out = runShell(
        `${SOURCE} psm_create_tmux_session "psm:omc:pr-123" "/tmp" >/dev/null;` +
          ` psm_kill_tmux_session "psm:omc:pr-123";` +
          ` psm_tmux_session_exists "psm_omc_pr-123" && echo STILL=yes || echo STILL=no`,
      );
      expect(out).toBe('killed|psm_omc_pr-123\nSTILL=no');
    });
  });

  describe('status reverse lookup', () => {
    it('maps a live tmux-safe session name back to the public id', () => {
      const home = mkdtempSync(join(tmpdir(), 'omc-psm-3528-'));
      mkdirSync(join(home, '.psm'), { recursive: true });
      writeFileSync(
        join(home, '.psm', 'sessions.json'),
        JSON.stringify({
          version: 1,
          sessions: {
            'omc:pr-123': { id: 'omc:pr-123', type: 'review', project: 'omc', tmux: 'psm_omc_pr-123' },
            'omc:issue-42': { id: 'omc:issue-42', type: 'fix', project: 'omc', tmux: 'psm_omc_issue-42' },
          },
          stats: { total_created: 2, total_cleaned: 0 },
        }),
      );
      const out = runShell(
        `source "${CONFIG_SH}"; source "${TMUX_SH}"; source "${SESSION_SH}";` +
          ` psm_get_session_id_for_tmux "psm_omc_issue-42"`,
        home,
      );
      expect(out).toBe('omc:issue-42');
    });
  });
});

describe('PSM tmux-safe naming — source & docs contract (issue #3528)', () => {
  const tmuxSrc = readFileSync(TMUX_SH, 'utf-8');
  const psmSrc = readFileSync(PSM_SH, 'utf-8');
  const skill = readFileSync(SKILL_MD, 'utf-8');

  it('defines the canonical contract functions', () => {
    expect(tmuxSrc).toMatch(/psm_tmux_safe_name\(\)\s*\{/);
    expect(tmuxSrc).toMatch(/psm_tmux_name_from_id\(\)\s*\{/);
    expect(tmuxSrc).toContain('${name//[.:]/_}');
  });

  it('sanitizes session_name at every tmux boundary', () => {
    const boundaries = [
      'psm_create_tmux_session',
      'psm_launch_claude',
      'psm_inject_prompt',
      'psm_wait_for_claude_prompt',
      'psm_kill_tmux_session',
      'psm_tmux_session_exists',
    ];
    for (const fn of boundaries) {
      const body = tmuxSrc.slice(tmuxSrc.indexOf(`${fn}()`));
      expect(body.slice(0, 200)).toContain('psm_tmux_safe_name "$1"');
    }
  });

  it('has a fail-closed post-create assertion', () => {
    expect(tmuxSrc).toContain('tmux session not found after create');
  });

  it('lists sessions by the tmux-safe prefix', () => {
    expect(tmuxSrc).toContain('grep "^psm_"');
    expect(tmuxSrc).not.toContain('grep "^psm:"');
  });

  it('psm.sh no longer builds colon-form tmux session names', () => {
    expect(psmSrc).not.toMatch(/session_name="psm:/);
    expect(psmSrc).toContain('psm_tmux_name_from_id "$session_id"');
    expect(psmSrc).toContain('psm_tmux_name_from_id "$id"');
  });

  it('SKILL.md advertises the tmux-safe session name, not the colon form', () => {
    expect(skill).toContain('psm_omc_pr-123');
    expect(skill).not.toContain('`psm:omc:pr-123`');
    expect(skill).not.toContain('grep "^psm:"');
  });
});
