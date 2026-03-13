#!/usr/bin/env tsx
/**
 * update-eval-tags.ts
 * eval 세트의 auto_tags를 canonical posts에서 갱신.
 * 포스트 선택(post_id)은 변경하지 않고, 태그만 업데이트.
 *
 * Usage: tsx scripts/update-eval-tags.ts
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost, EvalSet } from './types.js';

const EVAL_PATH = path.join(__dirname, '..', 'data', 'eval', 'eval_set_v1.json');
const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');

function main(): void {
  const evalSet: EvalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  const postMap = new Map<string, CanonicalPost>();
  for (const p of canonical.posts) {
    postMap.set(p.post_id, p);
  }

  let updated = 0;
  for (const ep of evalSet.posts) {
    const cp = postMap.get(ep.post_id);
    if (cp?.tags) {
      ep.auto_tags = cp.tags;
      updated++;
    }
  }

  const tmpPath = EVAL_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(evalSet, null, 2), 'utf8');
  fs.renameSync(tmpPath, EVAL_PATH);

  console.log(`Updated auto_tags for ${updated}/${evalSet.posts.length} posts`);
}

main();
