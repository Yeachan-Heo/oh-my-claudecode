/**
 * Verification Types
 *
 * Common types for verification protocol used across ralph, ultrawork, and autopilot
 */

/**
 * Types of verification evidence
 */
export type VerificationEvidenceType =
  | 'build_success'
  | 'test_pass'
  | 'lint_clean'
  | 'functionality_verified'
  | 'architect_approval'
  | 'todo_complete'
  | 'error_free';

/**
 * Proof of verification for a specific check
 */
export interface VerificationEvidence {
  /** Type of evidence */
  type: VerificationEvidenceType;
  /** Whether the check passed */
  passed: boolean;
  /** Command that was run to verify (if applicable) */
  command?: string;
  /** Output from the verification command */
  output?: string;
  /** Error message if check failed */
  error?: string;
  /** Timestamp when evidence was collected */
  timestamp: Date;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A single verification check requirement
 */
export interface VerificationCheck {
  /** Unique identifier for this check */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this check verifies */
  description: string;
  /** Type of evidence this check produces */
  evidenceType: VerificationEvidenceType;
  /** Whether this check is required for completion */
  required: boolean;
  /** Command to run for verification (if applicable) */
  command?: string;
  /** Whether this check has been completed */
  completed: boolean;
  /** Evidence collected for this check */
  evidence?: VerificationEvidence;
}

/**
 * Complete verification protocol definition
 */
export interface VerificationProtocol {
  /** Protocol name (e.g., "ralph", "autopilot", "ultrawork") */
  name: string;
  /** Description of what this protocol verifies */
  description: string;
  /** List of verification checks to perform */
  checks: VerificationCheck[];
  /** Whether all required checks must pass */
  strictMode: boolean;
  /** Optional custom validation function */
  customValidator?: (checklist: VerificationChecklist) => Promise<ValidationResult>;
}

/**
 * Current state of verification checks
 */
export interface VerificationChecklist {
  /** Protocol being followed */
  protocol: VerificationProtocol;
  /** Timestamp when verification started */
  startedAt: Date;
  /** Timestamp when verification completed (if finished) */
  completedAt?: Date;
  /** All checks with their current status */
  checks: VerificationCheck[];
  /** Overall completion status */
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  /** Summary of results */
  summary?: VerificationSummary;
}

/**
 * Summary of verification results
 */
export interface VerificationSummary {
  /** Total number of checks */
  total: number;
  /** Number of checks passed */
  passed: number;
  /** Number of checks failed */
  failed: number;
  /** Number of checks skipped (non-required) */
  skipped: number;
  /** Whether all required checks passed */
  allRequiredPassed: boolean;
  /** List of failed check IDs */
  failedChecks: string[];
  /** Overall verdict */
  verdict: 'approved' | 'rejected' | 'incomplete';
}

/**
 * Result of validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation message */
  message: string;
  /** List of issues found */
  issues: string[];
  /** Recommendations for fixing issues */
  recommendations?: string[];
}

/**
 * Options for running verification
 */
export interface VerificationOptions {
  /** Whether to run checks in parallel */
  parallel?: boolean;
  /** Timeout per check in milliseconds */
  timeout?: number;
  /** Whether to stop on first failure */
  failFast?: boolean;
  /** Whether to skip non-required checks */
  skipOptional?: boolean;
  /** Custom working directory */
  cwd?: string;
}

/**
 * Report format options
 */
export interface ReportOptions {
  /** Include detailed evidence in report */
  includeEvidence?: boolean;
  /** Include command output in report */
  includeOutput?: boolean;
  /** Format for report */
  format?: 'text' | 'markdown' | 'json';
  /** Whether to colorize output (for terminal) */
  colorize?: boolean;
}
