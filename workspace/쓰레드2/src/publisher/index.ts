/**
 * @file Publisher module — poster, warmup, account-manager, scheduler re-exports.
 */

// poster
export { postToThreads, gaussianDelay, humanType } from './poster.js';

// warmup
export { isWarmupComplete, getWarmupStatus, generateWarmupContent } from './warmup.js';

// account-manager
export {
  registerAccount,
  getActiveAccounts,
  updateAccountHealth,
  getAccountForPosting,
  retireAccount,
} from './account-manager.js';

// scheduler
export { getNextPostTime, getPublishQueue, processQueue } from './scheduler.js';
