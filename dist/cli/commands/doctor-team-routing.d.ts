/**
 * `omc doctor team-routing` — probe configured /team role-routing providers.
 *
 * Iterates every unique provider referenced by `team.roleRouting` (falling back
 * to `claude` when config is empty) and checks CLI presence on PATH.
 * Emits warnings (not errors) for missing binaries — AC-11.
 */
export declare function doctorTeamRoutingCommand(options: {
    json?: boolean;
}): Promise<number>;
//# sourceMappingURL=doctor-team-routing.d.ts.map