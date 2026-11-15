export declare const MAX_BLOCKS_WITHOUT_PROGRESS: number;

export declare class ProgressState {
  constructor(prev?: unknown);
  add(call: unknown): { progress: boolean; reason: string };
  state(): {
    paths: string[];
    errorSignatures: string[];
    failedKeys: string[];
    tests: { passing: number | null; failingMin: number | null };
  };
}

export declare function classifyTranscript(
  text: unknown,
  progress: ProgressState,
  fromTsMs?: number,
): { calls: number; progress: boolean };

export declare function isAcknowledgedBlockedExit(message: unknown): boolean;

export declare function normalizeSignature(text: unknown): string;
