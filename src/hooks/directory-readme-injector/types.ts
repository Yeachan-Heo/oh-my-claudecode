/**
 * Directory README Injector Types
 *
 * Type definitions for tracking injected README files per session.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */

/**
 * Storage data for tracking which directory READMEs have been injected
 * into a session's context.
 */
export interface InjectedPathsData {
  /** Session identifier */
  sessionID: string;
  /** List of directory paths whose READMEs have been injected */
  injectedPaths: string[];
  /** Timestamp of last update */
  updatedAt: number;
}
