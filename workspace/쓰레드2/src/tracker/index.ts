/**
 * @file Tracker module — re-exports snapshot collection, metrics calculation,
 * and diagnosis engine functions.
 */

// Snapshot collector
export {
  collectSnapshot,
  scheduleSnapshots,
  getPostMaturity,
  type SnapshotTarget,
} from './snapshot.js';

// Metrics & classification
export {
  calculateVelocity,
  classifyPerformance,
  getWeeklyCohort,
  getWeeklyStats,
  type VelocityInput,
  type VelocityResult,
  type ClassificationResult,
  type WeeklyStats,
} from './metrics.js';

// Diagnosis engine
export {
  diagnoseBottleneck,
  generateTuningActions,
  createDiagnosisReport,
  applyTuningAction,
  THRESHOLDS,
  type BottleneckType,
  type DiagnosisResult,
} from './diagnosis.js';
