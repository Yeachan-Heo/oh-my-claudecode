import { appendFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MEMORY_DIR = resolve(__dirname, '../../agents/memory');

function appendToFile(filename: string, content: string): void {
  const filepath = resolve(MEMORY_DIR, filename);
  if (!existsSync(filepath)) return;
  appendFileSync(filepath, '\n' + content);
}

export function logDecision(date: string, decision: string, rationale: string, outcome?: string): void {
  const entry = `\n### ${date}\n- **결정**: ${decision}\n- **근거**: ${rationale}${outcome ? `\n- **결과**: ${outcome}` : ''}\n`;
  appendToFile('strategy-log.md', entry);
}

export function logExperiment(experimentId: string, result: string): void {
  const entry = `\n### ${experimentId}\n- ${result}\n- 기록일: ${new Date().toISOString().slice(0, 10)}\n`;
  appendToFile('experiment-log.md', entry);
}

export function updatePlaybook(category: string, insight: string): void {
  const entry = `\n### ${new Date().toISOString().slice(0, 10)}\n- ${insight}\n`;
  appendToFile(`category-playbook/${category}.md`, entry);
}

export function updateWeeklyInsights(week: string, insights: string): void {
  const entry = `\n## ${week}\n${insights}\n`;
  appendToFile('weekly-insights.md', entry);
}
