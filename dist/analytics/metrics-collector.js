import * as fs from 'fs/promises';
import * as path from 'path';
const METRICS_LOG_FILE = '.omc/logs/metrics.jsonl';
export class MetricsCollector {
    async recordEvent(type, data, sessionId) {
        const event = {
            timestamp: new Date().toISOString(),
            type,
            data,
            sessionId
        };
        await this.appendToLog(event);
    }
    async query(query) {
        const logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);
        try {
            const content = await fs.readFile(logPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            let events = lines.map(line => JSON.parse(line));
            // Apply filters
            if (query.type) {
                events = events.filter(e => e.type === query.type);
            }
            if (query.sessionId) {
                events = events.filter(e => e.sessionId === query.sessionId);
            }
            if (query.startDate) {
                events = events.filter(e => e.timestamp >= query.startDate);
            }
            if (query.endDate) {
                events = events.filter(e => e.timestamp <= query.endDate);
            }
            // Apply pagination
            const offset = query.offset || 0;
            const limit = query.limit || events.length;
            return events.slice(offset, offset + limit);
        }
        catch (error) {
            return [];
        }
    }
    async aggregate(query, aggregator) {
        const events = await this.query(query);
        return aggregator(events);
    }
    async appendToLog(event) {
        const logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);
        const logDir = path.dirname(logPath);
        await fs.mkdir(logDir, { recursive: true });
        await fs.appendFile(logPath, JSON.stringify(event) + '\n', 'utf-8');
    }
}
// Common aggregators
export const aggregators = {
    sum: (field) => (events) => {
        return events.reduce((sum, e) => sum + (e.data[field] || 0), 0);
    },
    avg: (field) => (events) => {
        if (events.length === 0)
            return 0;
        const sum = aggregators.sum(field)(events);
        return sum / events.length;
    },
    count: () => (events) => {
        return events.length;
    },
    groupBy: (field) => (events) => {
        const groups = {};
        for (const event of events) {
            const key = event.data[field]?.toString() || 'unknown';
            if (!groups[key])
                groups[key] = [];
            groups[key].push(event);
        }
        return groups;
    },
    max: (field) => (events) => {
        if (events.length === 0)
            return 0;
        return Math.max(...events.map(e => e.data[field] || 0));
    },
    min: (field) => (events) => {
        if (events.length === 0)
            return 0;
        return Math.min(...events.map(e => e.data[field] || 0));
    }
};
// Singleton instance
let globalCollector = null;
export function getMetricsCollector() {
    if (!globalCollector) {
        globalCollector = new MetricsCollector();
    }
    return globalCollector;
}
//# sourceMappingURL=metrics-collector.js.map