#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import {
  appendManifestEntry,
  writeDraftFile,
  ManifestEntry,
} from '../draft-writer.js';
import {
  assembleDraft,
  CreateIssueFlags,
  INTERVIEW_SLOTS,
  InterviewSlot,
  CreateMode,
} from '../draft-assemble.js';

interface Args {
  idea: string;
  mode?: CreateMode;
  labels: string[];
  milestone?: string;
  noInterview: boolean;
  outputDir: string;
  manifestPath: string;
  area?: string;
  slotsFile?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    labels: [],
    noInterview: false,
    outputDir: '.omc/created-issues/drafts',
    manifestPath: '.omc/created-issues/manifest.json',
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i] as CreateMode;
    else if (a === '--label') out.labels = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--milestone') out.milestone = argv[++i];
    else if (a === '--no-interview') out.noInterview = true;
    else if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--manifest') out.manifestPath = argv[++i];
    else if (a === '--area') out.area = argv[++i];
    else if (a === '--slots-file') out.slotsFile = argv[++i];
    else positional.push(a);
  }
  out.idea = positional.join(' ').trim();
  return out as Args;
}

function loadSlots(slotsFile: string | undefined): InterviewSlot[] {
  if (!slotsFile || !existsSync(slotsFile)) return INTERVIEW_SLOTS.map((s) => ({ ...s }));
  try {
    const data = JSON.parse(readFileSync(slotsFile, 'utf-8')) as Record<string, string>;
    return INTERVIEW_SLOTS.map((s) => ({ ...s, value: data[s.name] }));
  } catch {
    return INTERVIEW_SLOTS.map((s) => ({ ...s }));
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const flags: CreateIssueFlags = {
    mode: args.mode,
    labels: args.labels,
    milestone: args.milestone,
    noInterview: args.noInterview,
    area: args.area,
  };
  const slots = args.noInterview
    ? INTERVIEW_SLOTS.map((s) => ({ ...s, value: undefined }))
    : loadSlots(args.slotsFile);
  const draft = assembleDraft(args.idea, slots, flags);
  const entry: ManifestEntry = appendManifestEntry(args.manifestPath, {
    title: draft.title,
    draft_path: '',
    content_hash: draft.contentHash,
    status: 'draft',
    issue_number: null,
    source: 'idea',
    mode: draft.mode,
    created_at: new Date().toISOString(),
  });
  const seq = entry.seq ?? 1;
  const draftPath = writeDraftFile(draft, args.outputDir, seq);
  process.stdout.write(JSON.stringify({
    ok: true,
    seq,
    draft_path: draftPath,
    title: draft.title,
    content_hash: draft.contentHash,
  }) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`draft-assemble: ${(err as Error).message}\n`);
  process.exit(1);
}
