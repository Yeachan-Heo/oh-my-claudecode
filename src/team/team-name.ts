const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export function validateTeamName(teamName: string): string {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error(
      `Invalid team name: "${teamName}". Team name must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.`
    );
  }
  return teamName;
}

/** Sanitize a team name to only lowercase alphanumeric + hyphens, max 30 chars. */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '').slice(0, 30);
}
