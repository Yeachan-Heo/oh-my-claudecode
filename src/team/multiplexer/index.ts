// src/team/multiplexer/index.ts
//
// Public exports for the multiplexer abstraction layer.

export {
  type CmuxLayout,
  type CmuxIdentity,
  type CmuxLeaderHandle,
  type CmuxWorkerHandle,
  CmuxUnsupportedError,
  CmuxCliNotFoundError,
  detectCmux,
  resolveLayout,
  resolveLeader,
  resolveCmuxBinary,
  spawnWorker,
  sendCommand,
  captureSurface,
  focusLeader,
  sessionName as cmuxSessionName,
  identify as cmuxIdentify,
} from './cmux-driver.js';
