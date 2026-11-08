export function isNonInteractive(): boolean {
  if (process.env.CI === "true" || process.env.CI === "1") {
    return true
  }

  if (process.env.CLAUDE_CODE_RUN === "true" || process.env.CLAUDE_CODE_NON_INTERACTIVE === "true") {
    return true
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    return true
  }

  if (process.stdout.isTTY !== true) {
    return true
  }

  return false
}
