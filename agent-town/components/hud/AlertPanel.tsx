"use client";

import { useState, useEffect, useCallback } from "react";
import HudFlyout from "./HudFlyout";

interface Alert {
  id: string;
  type: "pending_approval" | "strategy_change" | "performance_anomaly";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  created_at: string;
  actions: string[];
}

interface AlertData {
  alerts: Alert[];
  summary: { pending_approvals: number; strategy_changes: number; total: number };
}

const PRIORITY_COLOR: Record<Alert["priority"], string> = {
  high: "#ff6b6b",
  medium: "#f59e0b",
  low: "#60a5fa",
};

const PRIORITY_LABEL: Record<Alert["priority"], string> = {
  high: "긴급",
  medium: "보통",
  low: "낮음",
};

const TYPE_LABEL: Record<Alert["type"], string> = {
  pending_approval: "승인 대기",
  strategy_change: "전략 변경",
  performance_anomaly: "성과 이상",
};

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs / 24)}일 전`;
}

export default function AlertPanel() {
  const [data, setData] = useState<AlertData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/alerts");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류 발생");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void fetchData();
    const id = setInterval(() => void fetchData(), 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleAction = useCallback(
    async (alertId: string, action: string) => {
      setActingId(alertId);
      try {
        await fetch("/api/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: alertId, action }),
        });
        await fetchData();
      } catch {
        // silently ignore
      } finally {
        setActingId(null);
      }
    },
    [fetchData],
  );

  const subtitle = data
    ? `승인대기 ${data.summary.pending_approvals} · 전략변경 ${data.summary.strategy_changes} · 총 ${data.summary.total}`
    : undefined;

  if (loading) {
    return (
      <HudFlyout title="알림" subtitle={subtitle}>
        <div className="hud-empty">불러오는 중...</div>
      </HudFlyout>
    );
  }

  if (error || !data) {
    return (
      <HudFlyout title="알림">
        <div className="hud-empty" style={{ color: "#ff6b6b" }}>
          {error ?? "데이터 없음"}
        </div>
      </HudFlyout>
    );
  }

  return (
    <HudFlyout title="알림" subtitle={subtitle}>
      {data.alerts.length === 0 ? (
        <div className="hud-empty">알림 없음</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.alerts.map((alert) => {
            const priorityColor = PRIORITY_COLOR[alert.priority];
            const isActing = actingId === alert.id;
            return (
              <div
                key={alert.id}
                style={{
                  background: "rgba(0,0,0,0.35)",
                  border: `1px solid ${priorityColor}33`,
                  borderLeft: `3px solid ${priorityColor}`,
                  borderRadius: 4,
                  padding: "8px 10px",
                }}
              >
                {/* Header row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 700,
                      color: priorityColor,
                      background: `${priorityColor}22`,
                      border: `1px solid ${priorityColor}55`,
                      borderRadius: 3,
                      padding: "1px 5px",
                      textTransform: "uppercase",
                    }}
                  >
                    {PRIORITY_LABEL[alert.priority]}
                  </span>
                  <span
                    style={{
                      fontSize: 8,
                      color: "#8090b0",
                      background: "rgba(100,200,255,0.08)",
                      border: "1px solid rgba(100,200,255,0.12)",
                      borderRadius: 3,
                      padding: "1px 5px",
                    }}
                  >
                    {TYPE_LABEL[alert.type]}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 9, color: "#8090b0" }}>
                    {formatRelativeTime(alert.created_at)}
                  </span>
                </div>

                {/* Title */}
                <div
                  style={{
                    fontSize: 11,
                    color: "#e0e8ff",
                    fontWeight: 600,
                    marginBottom: 3,
                    lineHeight: 1.4,
                  }}
                >
                  {alert.title}
                </div>

                {/* Description */}
                <div
                  style={{
                    fontSize: 10,
                    color: "#8090b0",
                    lineHeight: 1.5,
                    marginBottom: 8,
                  }}
                >
                  {alert.description}
                </div>

                {/* Action buttons */}
                {alert.actions.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {alert.actions.map((action) => {
                      const isDanger =
                        action === "reject" || action === "deny";
                      const isPositive =
                        action === "approve" || action === "acknowledge";
                      const btnColor = isDanger
                        ? "#ff6b6b"
                        : isPositive
                          ? "#4ecdc4"
                          : "var(--pixel-accent)";
                      const actionLabel =
                        action === "approve"
                          ? "승인"
                          : action === "reject"
                            ? "거절"
                            : action === "acknowledge"
                              ? "확인"
                              : action;
                      return (
                        <button
                          key={action}
                          type="button"
                          disabled={isActing}
                          onClick={() => void handleAction(alert.id, action)}
                          style={{
                            padding: "3px 10px",
                            border: `1px solid ${btnColor}66`,
                            borderRadius: 3,
                            background: `${btnColor}18`,
                            color: btnColor,
                            fontSize: 9,
                            cursor: isActing ? "not-allowed" : "pointer",
                            fontFamily: "inherit",
                            textTransform: "uppercase",
                            opacity: isActing ? 0.5 : 1,
                          }}
                        >
                          {isActing ? "..." : actionLabel}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </HudFlyout>
  );
}
