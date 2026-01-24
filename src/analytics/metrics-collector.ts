import * as fs from 'fs/promises';
import * as path from 'path';

export interface MetricEvent {
  timestamp: string;
  type: string;
  data: Record<string, any>;
  sessionId?: string;
}

export interface MetricQuery {
  type?: string;
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

const METRICS_LOG_FILE = '.omc/logs/metrics.jsonl';

export class MetricsCollector {
  async recordEvent(type: string, data: Record<string, any>, sessionId?: string): Promise<void> {
    const event: MetricEvent = {
      timestamp: new Date().toISOString(),
      type,
      data,
      sessionId
    };

    await this.appendToLog(event);
  }

  async query(query: MetricQuery): Promise<MetricEvent[]> {
    const logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);

    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);

      let events: MetricEvent[] = lines.map(line => JSON.parse(line));

      // Apply filters
      if (query.type) {
        events = events.filter(e => e.type === query.type);
      }

      if (query.sessionId) {
        events = events.filter(e => e.sessionId === query.sessionId);
      }

      if (query.startDate) {
        events = events.filter(e => e.timestamp >= query.startDate!);
      }

      if (query.endDate) {
        events = events.filter(e => e.timestamp <= query.endDate!);
      }

      // Apply pagination
      const offset = query.offset || 0;
      const limit = query.limit || events.length;

      return events.slice(offset, offset + limit);
    } catch (error) {
      return [];
    }
  }

  async aggregate(
    query: MetricQuery,
    aggregator: (events: MetricEvent[]) => any
  ): Promise<any> {
    const events = await this.query(query);
    return aggregator(events);
  }

  private async appendToLog(event: MetricEvent): Promise<void> {
    const logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);
    const logDir = path.dirname(logPath);

    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(event) + '\n', 'utf-8');
  }
}

// Common aggregators
export const aggregators = {
  sum: (field: string) => (events: MetricEvent[]) => {
    return events.reduce((sum, e) => sum + (e.data[field] || 0), 0);
  },

  avg: (field: string) => (events: MetricEvent[]) => {
    if (events.length === 0) return 0;
    const sum = aggregators.sum(field)(events);
    return sum / events.length;
  },

  count: () => (events: MetricEvent[]) => {
    return events.length;
  },

  groupBy: (field: string) => (events: MetricEvent[]) => {
    const groups: Record<string, MetricEvent[]> = {};
    for (const event of events) {
      const key = event.data[field]?.toString() || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(event);
    }
    return groups;
  },

  max: (field: string) => (events: MetricEvent[]) => {
    if (events.length === 0) return 0;
    return Math.max(...events.map(e => e.data[field] || 0));
  },

  min: (field: string) => (events: MetricEvent[]) => {
    if (events.length === 0) return 0;
    return Math.min(...events.map(e => e.data[field] || 0));
  }
};

// Singleton instance
let globalCollector: MetricsCollector | null = null;

export function getMetricsCollector(): MetricsCollector {
  if (!globalCollector) {
    globalCollector = new MetricsCollector();
  }
  return globalCollector;
}
