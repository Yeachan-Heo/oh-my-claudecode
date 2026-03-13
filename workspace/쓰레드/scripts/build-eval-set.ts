#!/usr/bin/env tsx
/**
 * build-eval-set.ts
 * canonical posts에서 30개 eval 세트를 선별.
 * 채널/유형/참여도 다양성 보장.
 *
 * Usage:
 *   tsx scripts/build-eval-set.ts
 *   tsx scripts/build-eval-set.ts --count 30
 *   tsx scripts/build-eval-set.ts --seed 42
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost, EvalPost, EvalSet, GoldLabel } from './types.js';

const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const TAXONOMY_PATH = path.join(__dirname, '..', 'data', 'taxonomy.json');
const SCHEMA_PATH = path.join(__dirname, '..', 'docs', 'canonical-schema.json');
const EVAL_DIR = path.join(__dirname, '..', 'data', 'eval');

interface EvalOpts {
  count: number;
  seed: number;
}

function parseArgs(): EvalOpts & { force: boolean } {
  const args = process.argv.slice(2);
  const opts = { count: 30, seed: Date.now(), force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) opts.count = parseInt(args[++i]);
    if (args[i] === '--seed' && args[i + 1]) opts.seed = parseInt(args[++i]);
    if (args[i] === '--force') opts.force = true;
  }
  return opts;
}

// Simple seeded random (mulberry32)
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main(): void {
  const opts = parseArgs();

  // --- Rebuild protection: eval set is FROZEN after gold labeling ---
  const existingPath = path.join(EVAL_DIR, 'eval_set_v1.json');
  if (fs.existsSync(existingPath) && !opts.force) {
    const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    if (existing.meta?.labeling_status === 'complete') {
      console.error('ERROR: eval_set_v1.json already has gold labels (labeling_status=complete).');
      console.error('Rebuilding would invalidate gold labels because post selection depends on classifier output.');
      console.error('');
      console.error('Instead use:');
      console.error('  npx tsx scripts/update-eval-tags.ts   # update auto_tags without changing posts');
      console.error('  npx tsx scripts/apply-gold-labels.ts  # re-apply gold labels');
      console.error('  npx tsx scripts/eval-accuracy.ts      # measure accuracy');
      console.error('');
      console.error('To force rebuild (destroys gold labels): --force');
      process.exit(1);
    }
  }

  const rand = seededRandom(opts.seed);

  // Load canonical posts
  const data = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  const posts: CanonicalPost[] = data.posts;
  console.log(`Loaded ${posts.length} canonical posts`);

  // Load versions
  let taxonomyVersion = '1.0';
  let schemaVersion = '1.0';
  try { taxonomyVersion = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8')).version; } catch { /* ignore */ }
  try { schemaVersion = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')).version; } catch { /* ignore */ }

  // Strategy: balanced selection across channels and types
  const byChannel: Record<string, CanonicalPost[]> = {};
  for (const p of posts) {
    byChannel[p.channel_id] = byChannel[p.channel_id] || [];
    byChannel[p.channel_id].push(p);
  }
  const channels = Object.keys(byChannel).sort();

  const affiliate = posts.filter(p => p.tags?.primary === 'affiliate');
  const nonAffiliate = posts.filter(p => p.tags?.primary !== 'affiliate');

  console.log(`  Affiliate: ${affiliate.length}, Non-affiliate: ${nonAffiliate.length}`);
  console.log(`  Channels: ${channels.length}`);

  // Select: ensure at least 1 per channel, then balance affiliate/non-affiliate
  const selected = new Set<string>();
  const result: CanonicalPost[] = [];

  // Phase 1: 1 from each channel (prefer diverse types)
  for (const ch of channels) {
    const chPosts = byChannel[ch];
    const nonAff = chPosts.filter(p => p.tags?.primary !== 'affiliate');
    const aff = chPosts.filter(p => p.tags?.primary === 'affiliate');
    const pick = nonAff.length > 0
      ? nonAff[Math.floor(rand() * nonAff.length)]
      : aff[Math.floor(rand() * aff.length)];
    if (!selected.has(pick.post_id)) {
      selected.add(pick.post_id);
      result.push(pick);
    }
  }

  // Phase 2: Fill remaining slots with balanced selection
  const remaining = opts.count - result.length;
  if (remaining > 0) {
    const targetAff = Math.round(remaining * 0.4);
    const targetNonAff = remaining - targetAff;

    const sortByViews = (a: CanonicalPost, b: CanonicalPost) =>
      (b.metrics?.view_count || 0) - (a.metrics?.view_count || 0);

    const remainingAff = affiliate.filter(p => !selected.has(p.post_id)).sort(sortByViews);
    const remainingNon = nonAffiliate.filter(p => !selected.has(p.post_id)).sort(sortByViews);

    function pickDiverse(arr: CanonicalPost[], n: number): CanonicalPost[] {
      const picks: CanonicalPost[] = [];
      if (arr.length === 0 || n === 0) return picks;
      const step = Math.max(1, Math.floor(arr.length / n));
      for (let i = 0; i < n && i * step < arr.length; i++) {
        const idx = i * step;
        if (!selected.has(arr[idx].post_id)) {
          selected.add(arr[idx].post_id);
          picks.push(arr[idx]);
        }
      }
      for (const p of arr) {
        if (picks.length >= n) break;
        if (!selected.has(p.post_id)) {
          selected.add(p.post_id);
          picks.push(p);
        }
      }
      return picks;
    }

    result.push(...pickDiverse(remainingAff, targetAff));
    result.push(...pickDiverse(remainingNon, targetNonAff));
  }

  while (result.length > opts.count) result.pop();

  // Build eval set with labeling template
  const defaultGoldLabel: GoldLabel = {
    primary_tag: null,
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: null,
    notes: '',
  };

  const evalPosts: EvalPost[] = result.map((p, i) => ({
    eval_id: `E-${String(i + 1).padStart(3, '0')}`,
    post_id: p.post_id,
    channel_id: p.channel_id,
    text: p.text,
    timestamp: p.timestamp,
    permalink: p.permalink,
    thread_type: p.thread_type,
    link: p.link,
    metrics: p.metrics,
    comments: (p.comments || []).map(c => ({ text: c.text, has_affiliate_link: c.has_affiliate_link })),
    auto_tags: p.tags || { primary: 'general', secondary: [] },
    gold_label: { ...defaultGoldLabel },
  }));

  const evalSet: EvalSet = {
    meta: {
      version: 'v1',
      created_at: new Date().toISOString(),
      taxonomy_version: taxonomyVersion,
      schema_version: schemaVersion,
      total_posts: evalPosts.length,
      source: 'data/canonical/posts.json',
      selection_strategy: 'channel-balanced + type-balanced + engagement-diverse',
      seed: opts.seed,
      labeling_status: 'pending',
      channels_represented: [...new Set(evalPosts.map(p => p.channel_id))].sort(),
    },
    posts: evalPosts,
  };

  // Stats
  const evalStats = {
    total: evalPosts.length,
    channels: new Set(evalPosts.map(p => p.channel_id)).size,
    affiliate: evalPosts.filter(p => p.auto_tags.primary === 'affiliate').length,
    nonAffiliate: evalPosts.filter(p => p.auto_tags.primary !== 'affiliate').length,
  };

  // Write
  if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true });
  const outPath = path.join(EVAL_DIR, 'eval_set_v1.json');
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(evalSet, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  console.log(`\nEval set created: ${outPath}`);
  console.log(`  Total: ${evalStats.total}`);
  console.log(`  Channels: ${evalStats.channels}`);
  console.log(`  Affiliate: ${evalStats.affiliate}, Non-affiliate: ${evalStats.nonAffiliate}`);
  console.log(`  Taxonomy: ${taxonomyVersion}, Schema: ${schemaVersion}`);
  console.log(`\nNext: manually fill gold_label fields for each post.`);
}

main();
