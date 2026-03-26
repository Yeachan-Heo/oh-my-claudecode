'use client';
import { useState, useEffect, useCallback } from 'react';

interface PerformanceData {
  period: string;
  summary: Record<string, unknown>;
  growth: Record<string, number>;
  category_breakdown: Array<Record<string, unknown>>;
  top_posts: Array<Record<string, unknown>>;
}

interface AlertData {
  alerts: Array<Record<string, unknown>>;
  summary: Record<string, number>;
}

export function useDashboardData(period: string = '7d') {
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [alerts, setAlerts] = useState<AlertData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [perfRes, alertRes] = await Promise.all([
        fetch(`/api/dashboard/performance?period=${period}`),
        fetch('/api/alerts'),
      ]);
      if (perfRes.ok) setPerformance(await perfRes.json());
      if (alertRes.ok) setAlerts(await alertRes.json());
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { performance, alerts, loading, refresh };
}
