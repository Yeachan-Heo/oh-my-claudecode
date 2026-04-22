# oh-my-claudecode v4.19.4: stack-agent orchestration and product foundation

## Release Notes

Release with product-foundation, stack strategy/provisioning governance, and stricter Team pipeline state controls.

### Highlights

- **feat(team): add stack-agent orchestration state, subphases, dynamic routing, and Hard Rewind controls**
- **feat(stack-provision): enforce Strict Gate provenance, freshness, checksum, license, quarantine, and critic approval**
- **feat(skills): add product-foundation and product capability mapping before technology strategy**
- **docs(governance): define handoff envelopes, context budgets, artifact hygiene, and same-repository fresh-start rules**

### Validation

- `npm run test:run -- src/__tests__/skills.test.ts src/__tests__/stack-provision-init.test.ts src/__tests__/stack-provision-workflow.test.ts src/hooks/team-pipeline/__tests__/transitions.test.ts src/team/__tests__/role-router.test.ts src/team/__tests__/permissions.test.ts`
- `npx tsc --noEmit`
- `npm run lint`

# oh-my-claudecode v4.19.0: add --pre-mvp mode

## Release Notes

Release with **1 new feature** across **0 merged PRs**.

### Highlights

- **feat(agents,skills): add --pre-mvp mode to brand-steward**

### New Features

- **feat(agents,skills): add --pre-mvp mode to brand-steward**

### Stats

- **0 PRs merged** | **1 new feature** | **0 bug fixes** | **0 security/hardening improvements** | **0 other changes**
