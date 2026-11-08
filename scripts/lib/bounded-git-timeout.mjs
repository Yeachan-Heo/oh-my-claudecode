// Budget-coherent PER-CALL ceiling for nested git calls in generic hooks.
// Git-bearing hooks declare 5s so Windows inner runtime (3500ms) covers
// supervisor startup (≤600ms) + 2000ms git + margin. Non-proportional
// by design (see #3493, #3920).
export const BOUNDED_GIT_TIMEOUT_MS = 2000;
