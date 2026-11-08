import { describe, expect, it } from 'vitest'

import { nonInteractiveEnvHook } from './index.js'

describe('nonInteractiveEnvHook', () => {
  it('warns for simple banned interactive commands', async () => {
    const result = await nonInteractiveEnvHook.beforeCommand?.('less README.md')

    expect(result).toEqual({
      command: 'less README.md',
      warning: "Warning: 'less' is an interactive command that may hang in non-interactive environments.",
    })
  })

  it('warns with the correct banned git command after filtered entries', async () => {
    const result = await nonInteractiveEnvHook.beforeCommand?.('git rebase -i HEAD~2')

    expect(result?.warning).toBe(
      "Warning: 'git rebase -i' is an interactive command that may hang in non-interactive environments.",
    )
  })

  it('prepends non-interactive env vars to git commands', async () => {
    const result = await nonInteractiveEnvHook.beforeCommand?.('git status')

    expect(result?.warning).toBeUndefined()
    expect(result?.command).toContain('export ')
    expect(result?.command).toContain('GIT_TERMINAL_PROMPT=0')
    expect(result?.command).toContain("VISUAL=''")
    expect(result?.command).toContain('; git status')
  })

  it('keeps git warnings when also prepending env vars', async () => {
    const result = await nonInteractiveEnvHook.beforeCommand?.('git add -p src/hooks/non-interactive-env/index.ts')

    expect(result?.warning).toBe(
      "Warning: 'git add -p' is an interactive command that may hang in non-interactive environments.",
    )
    expect(result?.command).toContain('GIT_EDITOR=:')
    expect(result?.command).toContain('; git add -p src/hooks/non-interactive-env/index.ts')
  })
})
