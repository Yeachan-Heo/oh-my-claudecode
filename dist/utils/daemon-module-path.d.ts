/**
 * Resolve the module path used by forked daemon bootstrap scripts.
 *
 * - In source execution (*.ts), convert to the sibling compiled *.js path.
 * - In bundled CJS execution (bridge/cli.cjs), resolve to the dist module path.
 * - Otherwise keep the original path.
 */
export declare function resolveDaemonModulePath(currentFilename: string, distSegments: readonly string[]): string;
//# sourceMappingURL=daemon-module-path.d.ts.map