export {
  formatMergeReadinessArtifact,
  formatRuntimeMergeReadinessArtifact,
  formatUnderstandingGateArtifact,
  getMergeReadinessArtifactPath,
  getUnderstandingGateArtifactPath,
  writeMergeReadinessArtifact,
  writeRuntimeMergeReadinessArtifact,
  writeUnderstandingGateArtifact,
  type MergeReadinessArtifactInput,
  type MergeReadinessQuestion,
  type RuntimeMergeReadinessArtifactInput,
} from "../merge-readiness/artifact.js";

export type { MergeReadinessEvidence } from "../merge-readiness/types.js";

export type MergeReadinessResult = "pass" | "paused" | "blocked";
