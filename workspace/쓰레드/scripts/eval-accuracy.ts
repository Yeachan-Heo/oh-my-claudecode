#!/usr/bin/env tsx
/**
 * eval-accuracy.ts
 * auto_tags vs gold_label 정확도 측정.
 *
 * Metrics:
 *   - Tag accuracy: auto_tags.primary == gold_label.primary_tag
 *   - Signal precision: 규칙 기반 신호 vs gold 신호
 *   - Needs accuracy: 규칙 기반 니즈 vs gold 니즈
 *
 * Usage: tsx scripts/eval-accuracy.ts
 */

import fs from 'fs';
import path from 'path';
import type { EvalSet } from './types.js';

const EVAL_PATH = path.join(__dirname, '..', 'data', 'eval', 'eval_set_v1.json');
const NEEDS_PATH = path.join(__dirname, '..', 'data', 'briefs');

function main(): void {
  const evalSet: EvalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const posts = evalSet.posts;

  if (evalSet.meta.labeling_status !== 'complete') {
    console.error('Gold labels not complete. Run apply-gold-labels.ts first.');
    process.exit(1);
  }

  // --- 1. Tag Accuracy ---
  let tagCorrect = 0;
  let tagTotal = 0;
  const tagConfusion: Record<string, Record<string, number>> = {};
  const tagErrors: Array<{ eval_id: string; auto: string; gold: string; text: string }> = [];

  for (const p of posts) {
    const auto = p.auto_tags.primary;
    const gold = p.gold_label.primary_tag;
    if (!gold) continue;
    tagTotal++;

    if (!tagConfusion[gold]) tagConfusion[gold] = {};
    tagConfusion[gold][auto] = (tagConfusion[gold][auto] || 0) + 1;

    if (auto === gold) {
      tagCorrect++;
    } else {
      tagErrors.push({
        eval_id: p.eval_id,
        auto,
        gold,
        text: p.text.slice(0, 60).replace(/\n/g, ' '),
      });
    }
  }

  const tagAccuracy = tagTotal > 0 ? tagCorrect / tagTotal : 0;

  // --- 2. Signal Precision ---
  // Load research brief for rule-based signals
  const today = new Date().toISOString().slice(0, 10);
  let researchSignals: Record<string, string> = {};
  try {
    const briefFiles = fs.readdirSync(path.join(NEEDS_PATH));
    const researchFile = briefFiles.filter(f => f.endsWith('_research.json')).sort().pop();
    if (researchFile) {
      const research = JSON.parse(fs.readFileSync(path.join(NEEDS_PATH, researchFile), 'utf8'));
      for (const s of research.purchase_signals || []) {
        researchSignals[s.post_id] = s.signal_level;
      }
    }
  } catch { /* no research brief */ }

  // Signal: compare rule-based detection vs gold
  let signalTP = 0; // True positive: both have signal
  let signalFP = 0; // False positive: auto has signal, gold doesn't
  let signalFN = 0; // False negative: gold has signal, auto doesn't
  let signalTN = 0; // True negative: neither has signal
  let signalLevelMatch = 0;
  let signalLevelTotal = 0;

  for (const p of posts) {
    const autoSignal = researchSignals[p.post_id] || null;
    const goldSignal = p.gold_label.purchase_signal_level || null;

    if (autoSignal && goldSignal) {
      signalTP++;
      signalLevelTotal++;
      if (autoSignal === goldSignal) signalLevelMatch++;
    } else if (autoSignal && !goldSignal) {
      signalFP++;
    } else if (!autoSignal && goldSignal) {
      signalFN++;
    } else {
      signalTN++;
    }
  }

  const signalPrecision = (signalTP + signalFP) > 0 ? signalTP / (signalTP + signalFP) : 1;
  const signalRecall = (signalTP + signalFN) > 0 ? signalTP / (signalTP + signalFN) : 1;
  const signalF1 = (signalPrecision + signalRecall) > 0
    ? 2 * (signalPrecision * signalRecall) / (signalPrecision + signalRecall)
    : 0;

  // --- 3. Needs Accuracy ---
  // Load per-post needs classification
  let ruleNeeds: Record<string, string> = {};
  try {
    const briefFiles = fs.readdirSync(path.join(NEEDS_PATH));
    const needsFile = briefFiles.filter(f => f.endsWith('_needs.json')).sort().pop();
    if (needsFile) {
      const needs = JSON.parse(fs.readFileSync(path.join(NEEDS_PATH, needsFile), 'utf8'));
      // Use per-post classification if available, fallback to sample_post_ids
      if (needs.post_needs) {
        ruleNeeds = needs.post_needs;
      } else {
        for (const n of needs.needs_map || []) {
          for (const pid of n.sample_post_ids || []) {
            ruleNeeds[pid] = n.category;
          }
        }
      }
    }
  } catch { /* no needs data */ }

  let needsCorrect = 0;
  let needsTotal = 0;
  const needsErrors: Array<{ eval_id: string; auto: string | null; gold: string }> = [];

  for (const p of posts) {
    const goldNeed = p.gold_label.needs_category;
    if (!goldNeed) continue;
    needsTotal++;

    const autoNeed = ruleNeeds[p.post_id] || null;
    if (autoNeed === goldNeed) {
      needsCorrect++;
    } else {
      needsErrors.push({
        eval_id: p.eval_id,
        auto: autoNeed,
        gold: goldNeed,
      });
    }
  }

  const needsAccuracy = needsTotal > 0 ? needsCorrect / needsTotal : 0;

  // --- Output ---
  console.log('='.repeat(60));
  console.log('Eval Accuracy Report');
  console.log('='.repeat(60));

  console.log(`\n■ Tag Classification (auto_tags.primary vs gold_label.primary_tag)`);
  console.log(`  Accuracy: ${tagCorrect}/${tagTotal} = ${(tagAccuracy * 100).toFixed(1)}%`);
  console.log(`  Target: ≥ 70%`);
  console.log(`  Status: ${tagAccuracy >= 0.7 ? 'PASS ✓' : 'BELOW TARGET'}`);

  if (tagErrors.length > 0) {
    console.log(`\n  Misclassifications (${tagErrors.length}):`);
    for (const e of tagErrors) {
      console.log(`    ${e.eval_id}: auto=${e.auto} → gold=${e.gold} "${e.text}"`);
    }
  }

  console.log(`\n  Confusion matrix:`);
  const allTags = [...new Set([
    ...Object.keys(tagConfusion),
    ...Object.values(tagConfusion).flatMap(v => Object.keys(v)),
  ])].sort();
  console.log(`  ${'predicted→'.padStart(14)} ${allTags.map(t => t.slice(0, 8).padStart(9)).join('')}`);
  for (const gold of allTags) {
    const row = allTags.map(auto => String(tagConfusion[gold]?.[auto] || 0).padStart(9));
    console.log(`  ${gold.padStart(14)} ${row.join('')}`);
  }

  console.log(`\n■ Purchase Signal Detection`);
  console.log(`  Precision: ${signalTP}/${signalTP + signalFP} = ${(signalPrecision * 100).toFixed(1)}%`);
  console.log(`  Recall:    ${signalTP}/${signalTP + signalFN} = ${(signalRecall * 100).toFixed(1)}%`);
  console.log(`  F1:        ${(signalF1 * 100).toFixed(1)}%`);
  console.log(`  Target precision: ≥ 80%`);
  console.log(`  Status: ${signalPrecision >= 0.8 ? 'PASS ✓' : 'BELOW TARGET'}`);
  if (signalLevelTotal > 0) {
    console.log(`  Level match: ${signalLevelMatch}/${signalLevelTotal} = ${(signalLevelMatch / signalLevelTotal * 100).toFixed(1)}%`);
  }
  console.log(`  TP=${signalTP} FP=${signalFP} FN=${signalFN} TN=${signalTN}`);

  console.log(`\n■ Needs Category Classification`);
  console.log(`  Accuracy: ${needsCorrect}/${needsTotal} = ${(needsAccuracy * 100).toFixed(1)}%`);
  console.log(`  Target: ≥ 70%`);
  console.log(`  Status: ${needsAccuracy >= 0.7 ? 'PASS ✓' : 'BELOW TARGET'}`);

  if (needsErrors.length > 0) {
    console.log(`\n  Misclassifications (${needsErrors.length}):`);
    for (const e of needsErrors) {
      console.log(`    ${e.eval_id}: auto=${e.auto || 'none'} → gold=${e.gold}`);
    }
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Tag accuracy:       ${(tagAccuracy * 100).toFixed(1)}% ${tagAccuracy >= 0.7 ? '✓' : '✗'}`);
  console.log(`  Signal precision:   ${(signalPrecision * 100).toFixed(1)}% ${signalPrecision >= 0.8 ? '✓' : '✗'}`);
  console.log(`  Signal recall:      ${(signalRecall * 100).toFixed(1)}%`);
  console.log(`  Needs accuracy:     ${(needsAccuracy * 100).toFixed(1)}% ${needsAccuracy >= 0.7 ? '✓' : '✗'}`);

  const allPass = tagAccuracy >= 0.7 && signalPrecision >= 0.8 && needsAccuracy >= 0.7;
  console.log(`\n  Overall: ${allPass ? 'ALL TARGETS MET ✓' : 'SOME TARGETS NOT MET — LLM enhancement needed'}`);

  // Write report
  const report = {
    date: new Date().toISOString(),
    eval_set_version: evalSet.meta.version,
    sample_size: posts.length,
    tag_accuracy: +tagAccuracy.toFixed(4),
    signal_precision: +signalPrecision.toFixed(4),
    signal_recall: +signalRecall.toFixed(4),
    signal_f1: +signalF1.toFixed(4),
    needs_accuracy: +needsAccuracy.toFixed(4),
    targets_met: allPass,
    errors: { tag: tagErrors.length, signal_fp: signalFP, signal_fn: signalFN, needs: needsErrors.length },
  };

  const reportDir = path.join(__dirname, '..', 'data', 'eval');
  const reportPath = path.join(reportDir, 'accuracy_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport saved: ${reportPath}`);
}

main();
