import { describe, it, expect } from 'vitest';
import { renderSessionHealthAnalytics, renderAnalyticsLineWithConfig, getSessionHealthAnalyticsData, } from '../../hud/analytics-display.js';
describe('renderSessionHealthAnalytics', () => {
    const baseHealth = {
        durationMinutes: 5,
        messageCount: 0,
        health: 'healthy',
        sessionCost: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        costPerHour: 0,
        isEstimated: false,
    };
    it('renders with sessionCost = 0 (should NOT return empty)', () => {
        const result = renderSessionHealthAnalytics({ ...baseHealth, sessionCost: 0 });
        expect(result).not.toBe('');
        expect(result).toContain('$0.0000');
    });
    it('renders with non-zero analytics', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 1.2345,
            totalTokens: 50000,
            cacheHitRate: 45.6,
            costPerHour: 2.50,
        });
        expect(result).toContain('$1.2345');
        expect(result).toContain('50.0k');
        expect(result).toContain('45.6%');
        expect(result).toContain('| $2.50/h');
    });
    it('renders with estimated prefix when isEstimated is true', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 0.5,
            isEstimated: true,
        });
        expect(result).toContain('~$0.5000');
    });
    it('renders correct health indicator for healthy', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            health: 'healthy',
            sessionCost: 0.1,
        });
        expect(result).toContain('\u{1F7E2}'); // green circle
    });
    it('renders correct health indicator for warning', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            health: 'warning',
            sessionCost: 2.5,
        });
        expect(result).toContain('\u{1F7E1}'); // yellow circle
    });
    it('renders correct health indicator for critical', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            health: 'critical',
            sessionCost: 6.0,
        });
        expect(result).toContain('\u{1F534}'); // red circle
    });
    it('handles undefined totalTokens gracefully (fallback to 0)', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 1.0,
            totalTokens: undefined,
        });
        // Should not throw and should contain some token value
        expect(result).toBeDefined();
        expect(result).toContain('0');
    });
    it('handles undefined cacheHitRate gracefully (fallback to 0.0)', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 1.0,
            cacheHitRate: undefined,
        });
        // Should not throw and should contain cache percentage
        expect(result).toBeDefined();
        expect(result).toContain('0.0%');
    });
    it('handles large token counts with K suffix', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 0.5,
            totalTokens: 125000,
        });
        expect(result).toContain('125.0k');
    });
    it('handles very large token counts with M suffix', () => {
        const result = renderSessionHealthAnalytics({
            ...baseHealth,
            sessionCost: 5.0,
            totalTokens: 2500000,
        });
        expect(result).toContain('2.50M');
    });
});
describe('renderAnalyticsLineWithConfig', () => {
    const baseAnalytics = {
        sessionCost: '$1.2345',
        sessionTokens: '50.0k',
        topAgents: 'executor:$0.80 architect:$0.30',
        cacheEfficiency: '45.6%',
        costColor: 'green',
    };
    describe('showCost=true, showCache=true (default)', () => {
        it('renders all elements', () => {
            const result = renderAnalyticsLineWithConfig(baseAnalytics, true, true);
            expect(result).toContain('Cost: $1.2345');
            expect(result).toContain('Cache: 45.6%');
            expect(result).toContain('Top: executor:$0.80 architect:$0.30');
        });
        it('shows green indicator for green costColor', () => {
            const result = renderAnalyticsLineWithConfig({ ...baseAnalytics, costColor: 'green' }, true, true);
            expect(result).toContain('🟢');
        });
        it('shows yellow indicator for yellow costColor', () => {
            const result = renderAnalyticsLineWithConfig({ ...baseAnalytics, costColor: 'yellow' }, true, true);
            expect(result).toContain('🟡');
        });
        it('shows red indicator for red costColor', () => {
            const result = renderAnalyticsLineWithConfig({ ...baseAnalytics, costColor: 'red' }, true, true);
            expect(result).toContain('🔴');
        });
        it('handles empty topAgents gracefully', () => {
            const result = renderAnalyticsLineWithConfig({ ...baseAnalytics, topAgents: 'none' }, true, true);
            expect(result).toContain('Top: none');
        });
    });
    describe('showCost=false, showCache=true', () => {
        it('hides cost but shows cache', () => {
            const result = renderAnalyticsLineWithConfig(baseAnalytics, false, true);
            expect(result).not.toContain('Cost:');
            expect(result).toContain('Cache: 45.6%');
            expect(result).toContain('Top:');
        });
    });
    describe('showCost=true, showCache=false', () => {
        it('shows cost but hides cache', () => {
            const result = renderAnalyticsLineWithConfig(baseAnalytics, true, false);
            expect(result).toContain('Cost: $1.2345');
            expect(result).not.toContain('Cache:');
            expect(result).toContain('Top:');
        });
    });
    describe('showCost=false, showCache=false (minimal)', () => {
        it('shows only top agents', () => {
            const result = renderAnalyticsLineWithConfig(baseAnalytics, false, false);
            expect(result).not.toContain('Cost:');
            expect(result).not.toContain('Cache:');
            expect(result).toContain('Top:');
        });
        it('formats without pipe separators when minimal', () => {
            const result = renderAnalyticsLineWithConfig(baseAnalytics, false, false);
            expect(result).toBe('Top: executor:$0.80 architect:$0.30');
        });
    });
});
describe('getSessionHealthAnalyticsData', () => {
    const baseHealth = {
        durationMinutes: 5,
        messageCount: 0,
        health: 'healthy',
        sessionCost: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        costPerHour: 0,
        isEstimated: false,
    };
    describe('cost indicator', () => {
        it('returns green for healthy', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, health: 'healthy' });
            expect(data.costIndicator).toBe('🟢');
        });
        it('returns yellow for warning', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, health: 'warning' });
            expect(data.costIndicator).toBe('🟡');
        });
        it('returns red for critical', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, health: 'critical' });
            expect(data.costIndicator).toBe('🔴');
        });
    });
    describe('cost formatting', () => {
        it('formats with 4 decimal places', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, sessionCost: 1.2345 });
            expect(data.cost).toBe('$1.2345');
        });
        it('adds estimated prefix when isEstimated', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, sessionCost: 0.5, isEstimated: true });
            expect(data.cost).toBe('~$0.5000');
        });
        it('handles undefined as 0', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, sessionCost: undefined });
            expect(data.cost).toBe('$0.0000');
        });
    });
    describe('token formatting', () => {
        it('formats small counts without suffix', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, totalTokens: 999 });
            expect(data.tokens).toBe('999');
        });
        it('formats thousands with k suffix', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, totalTokens: 50000 });
            expect(data.tokens).toBe('50.0k');
        });
        it('formats millions with M suffix', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, totalTokens: 2500000 });
            expect(data.tokens).toBe('2.50M');
        });
    });
    describe('cache formatting', () => {
        it('formats with 1 decimal and percent', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, cacheHitRate: 45.67 });
            expect(data.cache).toBe('45.7%');
        });
        it('handles undefined as 0', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, cacheHitRate: undefined });
            expect(data.cache).toBe('0.0%');
        });
    });
    describe('cost per hour', () => {
        it('formats with dollar and /h suffix', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, costPerHour: 2.5 });
            expect(data.costHour).toBe('$2.50/h');
        });
        it('returns empty when undefined', () => {
            const data = getSessionHealthAnalyticsData({ ...baseHealth, costPerHour: undefined });
            expect(data.costHour).toBe('');
        });
    });
});
//# sourceMappingURL=analytics-display.test.js.map