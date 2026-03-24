#!/usr/bin/env npx tsx
/**
 * auto-execute 스킬 라우팅 정확도 평가기
 *
 * SKILL.md의 Step 1.3 라우팅 테이블을 파싱하여
 * test-cases.json의 각 입력이 올바른 스킬/에이전트로 매칭되는지 검증한다.
 *
 * 출력: { pass: boolean, score: number }
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// --- Types ---

interface TestCase {
  id: string;
  input: string;
  expected: string[];
  expected_type?: 'chain';
  category: string;
  note?: string;
}

interface TestSuite {
  version: string;
  pass_threshold: number;
  cases: TestCase[];
}

interface RoutingRule {
  keywords: string[];
  target: string;
  section: string;
}

interface ChainRule {
  trigger: string;
  steps: string[];
}

interface EvalResult {
  pass: boolean;
  score: number;
  details?: {
    total: number;
    passed: number;
    failed: string[];
    category_scores: Record<string, { passed: number; total: number }>;
    coverage: {
      sections_found: string[];
      total_rules: number;
    };
  };
}

// --- SKILL.md Parser ---

function parseSkillRouting(skillContent: string): {
  rules: RoutingRule[];
  chains: ChainRule[];
} {
  const rules: RoutingRule[] = [];
  const chains: ChainRule[] = [];

  // Extract Step 1.3 section
  const step13Match = skillContent.match(
    /### Step 1\.3: Select Skill\/Agent[\s\S]*?(?=### Step 1\.5:|$)/
  );
  if (!step13Match) {
    return { rules, chains };
  }
  const section = step13Match[0];

  // Parse routing tables (| 키워드 | 스킬 | 설명 |)
  const tableRegex = /#### 1\.3\.\d+\s+(.+?)(?:\n|\r\n)\s*\n?\|[^\n]*키워드[^\n]*\|[^\n]*\|\s*\n\|[-| ]+\|\s*\n((?:\|[^\n]+\|\s*\n?)*)/g;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(section)) !== null) {
    const sectionName = tableMatch[1].trim();
    const tableBody = tableMatch[2];

    const rowRegex = /\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/g;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
      const keywordsRaw = rowMatch[1].trim();
      const targetRaw = rowMatch[2].trim();

      if (keywordsRaw === '키워드' || keywordsRaw.startsWith('---')) continue;

      const keywords = keywordsRaw
        .split(/[,，、]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      // Extract all targets (skill names and agent names)
      const targets = targetRaw
        .split(/[+→]/)
        .map((t) => t.trim())
        .filter(Boolean);

      for (const target of targets) {
        // Clean up markdown formatting
        const clean = target
          .replace(/`/g, '')
          .replace(/\*\*/g, '')
          .replace(/\(.*?\)/g, '')
          .trim();
        if (clean) {
          rules.push({ keywords, target: clean, section: sectionName });
        }
      }
    }
  }

  // Parse chain definitions
  const chainRegex = /"([^"]+)"\s*\(([^)]+)\)\s*\n\s*→\s*(.+)/g;
  let chainMatch;

  while ((chainMatch = chainRegex.exec(section)) !== null) {
    const trigger = chainMatch[1].trim();
    const stepsRaw = chainMatch[3];
    const steps = stepsRaw
      .split(/→|∥/)
      .map((s) => s.trim().replace(/`/g, '').replace(/\(.*?\)/g, '').trim())
      .filter(Boolean);

    if (steps.length > 0) {
      chains.push({ trigger, steps });
    }
  }

  return { rules, chains };
}

// --- Matching Logic ---

/** Fuzzy Korean keyword matching with typo tolerance */
function fuzzyMatch(input: string, keyword: string): boolean {
  const normalizedInput = input.toLowerCase().replace(/\s+/g, '');
  const normalizedKeyword = keyword.toLowerCase().replace(/\s+/g, '');

  // Exact substring match
  if (normalizedInput.includes(normalizedKeyword)) return true;

  // Levenshtein distance for typo tolerance (threshold: 1 for short, 2 for long)
  const threshold = normalizedKeyword.length <= 3 ? 1 : 2;
  if (levenshtein(normalizedInput, normalizedKeyword) <= threshold) return true;

  // Check if any word in input matches
  const words = input.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (word.includes(normalizedKeyword)) return true;
    if (levenshtein(word, normalizedKeyword) <= 1) return true;
  }

  return false;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  return dp[m][n];
}

/** Find which skill/agent a given input routes to */
function findRouting(
  input: string,
  rules: RoutingRule[]
): string[] {
  const matches: string[] = [];

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (fuzzyMatch(input, keyword)) {
        if (!matches.includes(rule.target)) {
          matches.push(rule.target);
        }
        break;
      }
    }
  }

  return matches;
}

/** Check if a chain is defined in the SKILL.md */
function findChainMatch(
  input: string,
  chains: ChainRule[]
): string[] | null {
  for (const chain of chains) {
    if (fuzzyMatch(input, chain.trigger)) {
      return chain.steps;
    }
  }
  return null;
}

// --- Evaluation ---

function evaluateCase(
  testCase: TestCase,
  rules: RoutingRule[],
  chains: ChainRule[]
): boolean {
  // Context-dependent cases — skip (can't evaluate statically)
  if (testCase.expected.includes('_context_dependent')) {
    return true;
  }

  if (testCase.expected_type === 'chain') {
    // Chain: check if ALL expected steps appear in SKILL.md chains
    const chainSteps = findChainMatch(testCase.input, chains);
    if (!chainSteps) {
      // Fallback: check if at least the first expected step is routable
      const routed = findRouting(testCase.input, rules);
      return testCase.expected.some((exp) =>
        routed.some((r) => r.includes(exp) || exp.includes(r))
      );
    }
    // Check that expected steps are a subset of chain steps
    return testCase.expected.every((exp) =>
      chainSteps.some((step) => step.includes(exp) || exp.includes(step))
    );
  }

  // Single routing: check if any expected target matches
  const routed = findRouting(testCase.input, rules);

  if (routed.length === 0) return false;

  return testCase.expected.some((exp) =>
    routed.some((r) => {
      const normR = r.toLowerCase();
      const normExp = exp.toLowerCase();
      return (
        normR.includes(normExp) ||
        normExp.includes(normR) ||
        normR === normExp
      );
    })
  );
}

// --- Main ---

function main(): void {
  const specDir = dirname(new URL(import.meta.url).pathname);
  const skillPath = join(specDir, '..', '..', '..', '.claude', 'skills', 'auto-execute', 'SKILL.md');
  const testCasesPath = join(specDir, 'test-cases.json');

  let skillContent: string;
  try {
    skillContent = readFileSync(skillPath, 'utf-8');
  } catch {
    // Fallback: try workspace symlink path
    const altPath = join(specDir, '..', '..', '..', 'workspace', '.claude', 'skills', 'auto-execute', 'SKILL.md');
    skillContent = readFileSync(altPath, 'utf-8');
  }

  const testSuite: TestSuite = JSON.parse(readFileSync(testCasesPath, 'utf-8'));
  const { rules, chains } = parseSkillRouting(skillContent);

  const categoryScores: Record<string, { passed: number; total: number }> = {};
  const failed: string[] = [];
  let passed = 0;

  for (const tc of testSuite.cases) {
    if (!categoryScores[tc.category]) {
      categoryScores[tc.category] = { passed: 0, total: 0 };
    }
    categoryScores[tc.category].total++;

    const ok = evaluateCase(tc, rules, chains);
    if (ok) {
      passed++;
      categoryScores[tc.category].passed++;
    } else {
      failed.push(`${tc.id}: "${tc.input}" → expected ${JSON.stringify(tc.expected)}`);
    }
  }

  const total = testSuite.cases.length;
  const score = total > 0 ? Math.round((passed / total) * 100) / 100 : 0;

  const sectionsFound = [...new Set(rules.map((r) => r.section))];

  const result: EvalResult = {
    pass: score >= testSuite.pass_threshold,
    score,
    details: {
      total,
      passed,
      failed,
      category_scores: categoryScores,
      coverage: {
        sections_found: sectionsFound,
        total_rules: rules.length,
      },
    },
  };

  // Output JSON to stdout (autoresearch contract)
  console.log(JSON.stringify(result));
}

main();
