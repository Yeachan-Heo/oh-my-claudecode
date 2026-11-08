export function buildRalphthonDeepInterviewPrompt(task: string, maxWaves: number, pollIntervalMs: number): string {
  const sanitizedTask = task.replace(/[\r\n\0]+/g, ' ').trim();

  return `/deep-interview ${sanitizedTask}

Interview guidance for this ralphthon intake:
- Treat current weakest-dimension targeting as explicit every round: name the weakest dimension, explain why it is the bottleneck, then ask one question.
- For brownfield confirmations, cite the repo evidence that triggered the question (file path, symbol, or pattern) before asking the user to choose a direction.
- If scope remains fuzzy because the core entity keeps shifting, use ontology-style questioning to identify what the thing fundamentally IS before asking for more feature detail.

After the interview, generate a ralphthon-prd.json file in .omc/ with this structure:
{
  "project": "<project name>",
  "branchName": "<branch>",
  "description": "<description>",
  "stories": [{ "id": "US-001", "title": "...", "description": "...", "acceptanceCriteria": [...], "priority": "high", "tasks": [{ "id": "T-001", "title": "...", "description": "...", "status": "pending", "retries": 0 }] }],
  "hardening": [],
  "config": { "maxWaves": ${maxWaves}, "cleanWavesForTermination": 3, "pollIntervalMs": ${pollIntervalMs}, "idleThresholdMs": 30000, "maxRetries": 3, "skipInterview": false }
}`;
}
