interface DiversityResult {
  warning: string | null;
  dominant?: string;
  ratio?: number;
  repeated?: string;
  count?: number;
}

interface DiversityReport {
  warnings: DiversityResult[];
  isHealthy: boolean;
}

export function checkFormatDiversity(posts: Array<{ content_style: string }>): DiversityResult {
  const counts = new Map<string, number>();
  for (const p of posts) {
    counts.set(p.content_style, (counts.get(p.content_style) || 0) + 1);
  }
  const [dominant, maxCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const ratio = posts.length > 0 ? maxCount / posts.length : 0;
  if (ratio > 0.6) {
    return { warning: '포맷 단조로움', dominant, ratio: Math.round(ratio * 100) };
  }
  return { warning: null };
}

export function checkCategoryDiversity(posts: Array<{ need_category: string }>): DiversityResult {
  const counts = new Map<string, number>();
  for (const p of posts) {
    counts.set(p.need_category, (counts.get(p.need_category) || 0) + 1);
  }
  const [dominant, maxCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const ratio = posts.length > 0 ? maxCount / posts.length : 0;
  if (ratio > 0.5) {
    return { warning: '카테고리 편중', dominant, ratio: Math.round(ratio * 100) };
  }
  return { warning: null };
}

export function checkHookDiversity(posts: Array<{ hook_type: string }>): DiversityResult {
  const counts = new Map<string, number>();
  for (const p of posts) {
    counts.set(p.hook_type, (counts.get(p.hook_type) || 0) + 1);
  }
  for (const [hook, count] of counts) {
    if (count >= 3) {
      return { warning: '훅 반복', repeated: hook, count };
    }
  }
  return { warning: null };
}

export function getDiversityReport(posts: Array<{ content_style: string; need_category: string; hook_type: string }>): DiversityReport {
  const warnings = [
    checkFormatDiversity(posts),
    checkCategoryDiversity(posts),
    checkHookDiversity(posts),
  ].filter(r => r.warning !== null);
  return { warnings, isHealthy: warnings.length === 0 };
}
