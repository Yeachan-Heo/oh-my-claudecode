/**
 * Tests for the Jev "model-routing" shadow wiring (issue-3669, judgment point ④).
 *
 * External behavior only: given a stubbed HTTP transport, the shadow wiring
 * records the pinned tier beside Jev's Choice when the key is set, and makes
 * zero HTTP calls with no key or with OMC_JEV=off. The enforcement result is
 * byte-identical either way — Jev never overrides the enforcer in shadow.
 */
export {};
//# sourceMappingURL=jev-model-routing.test.d.ts.map