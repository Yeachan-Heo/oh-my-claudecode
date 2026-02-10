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
export declare class MetricsCollector {
    recordEvent(type: string, data: Record<string, any>, sessionId?: string): Promise<void>;
    query(query: MetricQuery): Promise<MetricEvent[]>;
    aggregate(query: MetricQuery, aggregator: (events: MetricEvent[]) => any): Promise<any>;
    private appendToLog;
}
export declare const aggregators: {
    sum: (field: string) => (events: MetricEvent[]) => number;
    avg: (field: string) => (events: MetricEvent[]) => number;
    count: () => (events: MetricEvent[]) => number;
    groupBy: (field: string) => (events: MetricEvent[]) => Record<string, MetricEvent[]>;
    max: (field: string) => (events: MetricEvent[]) => number;
    min: (field: string) => (events: MetricEvent[]) => number;
};
export declare function getMetricsCollector(): MetricsCollector;
//# sourceMappingURL=metrics-collector.d.ts.map