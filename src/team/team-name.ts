const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export function validateTeamName(teamName: string): string {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error(
      `Invalid team name: "${teamName}". Team name must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.`
    );
  }
  return teamName;
}
