import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock('../callbacks.js', async () => {
  const actual = await vi.importActual<typeof import('../callbacks.js')>('../callbacks.js');
  return {
    ...actual,
    triggerStopCallbacks: vi.fn(async () => undefined),
  };
});

vi.mock("../../../notifications/index.js", () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock("../../../features/auto-update.js", () => ({
  getOMCConfig: vi.fn(() => ({})),
}));

vi.mock("../../../notifications/config.js", () => ({
  buildConfigFromEnv: vi.fn(() => null),
  getEnabledPlatforms: vi.fn(() => []),
  getNotificationConfig: vi.fn(() => null),
}));

vi.mock("../../../tools/python-repl/bridge-manager.js", () => ({
  cleanupBridgeSessions: vi.fn(async () => ({
    requestedSessions: 0,
    foundSessions: 0,
    terminatedSessions: 0,
    errors: [],
  })),
}));

vi.mock("../../../openclaw/index.js", () => ({
  wakeOpenClaw: vi.fn().mockResolvedValue({ gateway: "test", success: true }),
}));

const workerMocks = vi.hoisted(() => ({
  processSessionEndWorker: vi.fn(),
  spawnSessionEndWorker: vi.fn(),
}));

vi.mock('../worker.js', () => workerMocks);
vi.mock('../../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/worktree-paths.js')>(
    '../../../lib/worktree-paths.js',
  );
  return { ...actual, resolveToWorktreeRoot: vi.fn((directory?: string) => directory ?? process.cwd()) };
});

import { processHook, type HookInput } from '../../bridge.js';
import { processSessionEnd, runSessionEndOpenClaw } from '../index.js';
import { readSessionEndJob } from '../cleanup-manifest.js';
import { wakeOpenClaw } from '../../../openclaw/index.js';

describe("session-end OpenClaw behavior (issue #1456)", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-end-claw-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    // Write a minimal transcript so processSessionEnd doesn't fail
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      }),
      "utf-8",
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defers an enabled OpenClaw wake from the bridge and executes it in the worker adapter', async () => {
    process.env.OMC_OPENCLAW = '1';

    await processHook('session-end', {
      session_id: 'session-claw-1',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    } as unknown as HookInput);

    const manifest = readSessionEndJob(tmpDir, 'session-claw-1');
    expect(manifest?.actions.openclaw).toEqual(expect.objectContaining({
      status: 'pending',
      payload: expect.objectContaining({ transcriptPath, reason: 'clear' }),
    }));
    expect(manifest?.actions.callback.payload).toEqual(expect.objectContaining({
      input: expect.objectContaining({ reason: 'clear', transcript_path: transcriptPath, cwd: tmpDir }),
      metrics: expect.objectContaining({ session_id: 'session-claw-1', reason: 'clear' }),
    }));
    expect(workerMocks.spawnSessionEndWorker).toHaveBeenCalledWith({
      directory: tmpDir,
      sessionId: 'session-claw-1',
    });
    expect(wakeOpenClaw).not.toHaveBeenCalled();

    await runSessionEndOpenClaw(tmpDir, 'session-claw-1');

    expect(wakeOpenClaw).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({
        sessionId: 'session-claw-1',
        projectPath: tmpDir,
      }),
    );
  });

  it('does not call wakeOpenClaw directly when processSessionEnd is invoked without the bridge', async () => {
    process.env.OMC_OPENCLAW = '1';

    await processSessionEnd({
      session_id: 'session-claw-2',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(wakeOpenClaw).not.toHaveBeenCalled();
  });

  it('does not wake OpenClaw from the worker adapter when OMC_OPENCLAW is not set', async () => {
    delete process.env.OMC_OPENCLAW;

    await processSessionEnd({
      session_id: 'session-claw-3',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });
    await runSessionEndOpenClaw(tmpDir, 'session-claw-3');

    expect(wakeOpenClaw).not.toHaveBeenCalled();
  });

  it('contains a rejected worker wake without failing session-end processing', async () => {
    process.env.OMC_OPENCLAW = '1';
    vi.mocked(wakeOpenClaw).mockRejectedValueOnce(new Error('gateway down'));

    await processSessionEnd({
      session_id: 'session-claw-4',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    await expect(runSessionEndOpenClaw(tmpDir, 'session-claw-4')).resolves.toBeUndefined();
  });
});
