/**
 * The whole path from sendReplyInjectionSteps to the daemon log on native Windows when `where tmux` resolves a `.cmd`
 * wrapper (psmux): the real tmuxExec and resolveTmuxInvocation build the command line, with quoteForCmd around every
 * argument, and only the process is replaced (execFileSync fails the way Node reports a failed command:
 * `Command failed: <file> <arguments joined by spaces>`).
 */
export {};
//# sourceMappingURL=reply-listener-cmd-wrapper.test.d.ts.map