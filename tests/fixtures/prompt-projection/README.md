# Prompt projection parity fixtures for #3705

These fixtures freeze normalized behavior contracts for generated projections.

- `claude-managed-block.golden` — expected `<!-- OMC:START -->` / `<!-- OMC:VERSION:x -->` / body / `<!-- OMC:END -->` framing produced by composer or `renderManaged`.
- `claude-body.normalized` — LF-normalized canonical body (no version) used for `sourceRevision` handshake.
- `transaction-backup-rollback.json` — describes transaction phases exercised by `src/installer/__tests__/claude-md-transaction.test.ts` (backup, mutation, rollback, idempotent rerun).

Regenerate fixtures only by running `npm run generate:prompt-projections && npm run build` then copying verified outputs. Do not edit by hand.
