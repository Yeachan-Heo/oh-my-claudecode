/**
 * Swarm Coordination Types
 *
 * Type definitions for the SQLite-based swarm coordination system.
 * Swarm enables multiple agents to claim and work on tasks atomically
 * with lease-based ownership and heartbeat monitoring.
 */
/**
 * Default configuration values
 */
export const DEFAULT_SWARM_CONFIG = {
    agentCount: 3,
    tasks: [],
    agentType: 'executor',
    leaseTimeout: 5 * 60 * 1000, // 5 minutes
    heartbeatInterval: 60 * 1000 // 60 seconds
};
/**
 * Database schema version for migrations
 */
export const DB_SCHEMA_VERSION = 2;
//# sourceMappingURL=types.js.map