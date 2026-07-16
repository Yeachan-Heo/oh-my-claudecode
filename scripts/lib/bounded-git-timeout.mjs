// Budget-coherent PER-CALL ceiling for nested git calls in generic hooks.
// 2000ms < the smallest hook manifest budget (3s), so an inner git timeout
// fires before the runner's generic-execution timeout. Non-proportional by design (see #3493).
export const BOUNDED_GIT_TIMEOUT_MS = 2000;
