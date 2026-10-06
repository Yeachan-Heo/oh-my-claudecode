/**
 * B9 spawn-next self-heal, hook-side half: once the manifest exists it already
 * carries the enqueued chain, so processSessionEnd must always launch the
 * worker — even when inline foreground cleanup or core sealing fails. Without
 * the spawn the enqueued chain has no executor at all (producer absent, no
 * self-heal) and stalls until an unrelated SessionStart reconcile.
 */
export {};
//# sourceMappingURL=process-session-end-worker-spawn.test.d.ts.map