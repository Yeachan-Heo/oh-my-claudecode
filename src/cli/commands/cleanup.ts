import { getQueryEngine } from '../../analytics/query-engine.js';
import { cleanupStaleBackgroundTasks } from '../../hud/background-cleanup.js';
import { colors } from '../utils/formatting.js';
import { cleanupStaleBridges } from '../../tools/python-repl/bridge-manager.js';

export async function cleanupCommand(options: { retention?: number }): Promise<void> {
  console.log(colors.bold('\n🧹 Running Cleanup...\n'));

  const retentionDays = options.retention || 30;

  // Clean old token logs
  const engine = getQueryEngine();
  const { removedTokens, removedMetrics } = await engine.cleanupOldData(retentionDays);

  // Clean stale background tasks
  const removedTasks = await cleanupStaleBackgroundTasks();

  // Clean stale python bridge artifacts (bridge_meta.json/bridge.sock/session.lock)
  const pythonCleanup = await cleanupStaleBridges();

  console.log(`Removed ${removedTokens} old token logs (older than ${retentionDays} days)`);
  console.log(`Removed ${removedMetrics} old metric events`);
  console.log(`Removed ${removedTasks} stale background tasks`);
  console.log(
    `Removed ${pythonCleanup.filesRemoved} stale python_repl bridge file(s) ` +
      `(${pythonCleanup.staleSessions} stale session(s), ${pythonCleanup.activeSessions} active session(s) skipped)`
  );
  console.log(colors.green('\n✓ Cleanup complete\n'));
}
