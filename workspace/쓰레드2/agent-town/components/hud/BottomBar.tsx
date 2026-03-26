"use client";

import { useEffect, useState } from "react";
import { FileText, TrendingUp, Clock } from "lucide-react";
import { STATUS_LABELS } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import type { ConnectionStatus } from "@/types/game";

const POSTS_TARGET_DEFAULT = 5;

interface KpiState {
  postsToday: number;
  postsTarget: number;
  warmupCurrent: number;
  warmupTarget: number;
  pendingApprovals: number;
}

const DEFAULT_KPI: KpiState = {
  postsToday: 0,
  postsTarget: POSTS_TARGET_DEFAULT,
  warmupCurrent: 19,
  warmupTarget: 20,
  pendingApprovals: 0,
};

interface BottomBarProps {
  connection: ConnectionStatus;
}

export default function BottomBar({ connection }: BottomBarProps) {
  const [kpi, setKpi] = useState<KpiState>(DEFAULT_KPI);

  useEffect(() => {
    async function fetchKpi() {
      try {
        const [perfRes, alertsRes, warmupRes] = await Promise.allSettled([
          fetch("/api/dashboard/performance?period=today").then((r) => r.json()),
          fetch("/api/alerts").then((r) => r.json()),
          supabase
            .from("content_lifecycle")
            .select("id", { count: "exact", head: true })
            .not("posted_at", "is", null),
        ]);

        setKpi((prev) => {
          const next = { ...prev };

          if (perfRes.status === "fulfilled" && perfRes.value?.summary) {
            next.postsToday = perfRes.value.summary.total_posts ?? prev.postsToday;
          }

          if (alertsRes.status === "fulfilled" && alertsRes.value?.summary) {
            next.pendingApprovals =
              alertsRes.value.summary.pending_approvals ?? prev.pendingApprovals;
          }

          if (warmupRes.status === "fulfilled" && warmupRes.value.count !== null) {
            next.warmupCurrent = warmupRes.value.count ?? prev.warmupCurrent;
          }

          return next;
        });
      } catch {
        // 에러 시 기존 값 유지
      }
    }

    fetchKpi();
    const interval = setInterval(fetchKpi, 30_000);
    return () => clearInterval(interval);
  }, []);

  const warmupPct = Math.round((kpi.warmupCurrent / kpi.warmupTarget) * 100);

  return (
    <div className="layout-bottombar">
      <div className="hud-pill hud-pill--connection">
        <span
          className={`pixel-dot pixel-dot--${
            connection === "connected" ? "green" : connection === "connecting" ? "yellow" : "red"
          }`}
        />
        <span>{STATUS_LABELS[connection]}</span>
      </div>

      {/* 포스트: 오늘 게시 / 목표 */}
      <div className="hud-pill hud-pill--metric">
        <FileText size={10} />
        <span>
          포스트 {kpi.postsToday}/{kpi.postsTarget}
        </span>
      </div>

      {/* 워밍업 진행률 */}
      <div className="hud-pill hud-pill--metric">
        <TrendingUp size={10} />
        <span>
          워밍업 {kpi.warmupCurrent}/{kpi.warmupTarget} ({warmupPct}%)
        </span>
      </div>

      {/* 승인 대기 */}
      <div
        className={`hud-pill ${kpi.pendingApprovals > 0 ? "hud-pill--warning" : "hud-pill--metric"}`}
      >
        <Clock size={10} />
        <span>승인 대기 {kpi.pendingApprovals}</span>
      </div>
    </div>
  );
}
