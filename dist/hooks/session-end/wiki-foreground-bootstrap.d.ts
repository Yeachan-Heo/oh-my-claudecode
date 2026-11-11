export interface WikiSessionEndBootstrapInput {
    session_id: string;
    cwd: string;
}
export interface WikiSessionEndBootstrapResult {
    continue: true;
}
/**
 * Wiki SessionEnd producer: no foreground lock or wiki write, it only seals a
 * durable capture/no-op intent and hands off to the existing worker.
 *
 * Lives outside `index.ts` for the same reason as `foreground-bootstrap.ts`:
 * `scripts/wiki-session-end.mjs` runs inside run.cjs's fixed 300ms SessionEnd
 * foreground budget, and importing the full SessionEnd module graph there
 * timed the hook out before the intent was sealed.
 */
export declare function publishWikiSessionEndBootstrap(input: WikiSessionEndBootstrapInput): Promise<WikiSessionEndBootstrapResult>;
export default publishWikiSessionEndBootstrap;
//# sourceMappingURL=wiki-foreground-bootstrap.d.ts.map