"use client";

import { useState, useEffect, useCallback } from "react";
import HudFlyout from "./HudFlyout";

interface PerformanceSummary {
  total_posts: number;
  total_views: number;
  total_likes: number;
  total_comments: number;
  total_reposts: number;
  avg_engagement_rate: number;
  revenue: number;
  warmup_progress: string;
}

interface GrowthData {
  views_change_pct: number;
  likes_change_pct: number;
  engagement_change_pct: number;
}

interface CategoryBreakdown {
  category: string;
  posts: number;
  avg_views: number;
  engagement_rate: number;
}

interface TopPost {
  post_id: string;
  text_preview: string;
  views: number;
  category: string;
  posted_at: string;
}

interface DashboardData {
  period: string;
  summary: PerformanceSummary;
  growth: GrowthData;
  category_breakdown: CategoryBreakdown[];
  top_posts: TopPost[];
}

type Period = "today" | "7d" | "30d";

const PERIOD_LABEL: Record<Period, string> = {
  today: "오늘",
  "7d": "7일",
  "30d": "30일",
};

function GrowthBadge({ pct }: { pct: number }) {
  const positive = pct >= 0;
  const color = positive ? "#4ecdc4" : "#ff6b6b";
  const sign = positive ? "+" : "";
  return (
    <span style={{ color, fontSize: 10, fontWeight: 600 }}>
      {sign}{pct.toFixed(1)}%
    </span>
  );
}

export default function DashboardPanel() {
  const [period, setPeriod] = useState<Period>("7d");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/api/dashboard/performance?period=${period}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류 발생");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    void fetchData();
    const id = setInterval(() => void fetchData(), 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const headerAction = (
    <div style={{ display: "flex", gap: 4 }}>
      {(["today", "7d", "30d"] as Period[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => setPeriod(p)}
          style={{
            padding: "2px 6px",
            border: `1px solid ${period === p ? "var(--pixel-accent)" : "var(--pixel-border)"}`,
            borderRadius: 3,
            background: period === p ? "rgba(201,162,39,0.18)" : "transparent",
            color: period === p ? "var(--pixel-accent)" : "var(--pixel-muted)",
            fontSize: 9,
            cursor: "pointer",
            fontFamily: "inherit",
            textTransform: "uppercase",
          }}
        >
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <HudFlyout title="성과 대시보드" headerAction={headerAction}>
        <div className="hud-empty">불러오는 중...</div>
      </HudFlyout>
    );
  }

  if (error || !data) {
    return (
      <HudFlyout title="성과 대시보드" headerAction={headerAction}>
        <div className="hud-empty" style={{ color: "#ff6b6b" }}>
          {error ?? "데이터 없음"}
        </div>
      </HudFlyout>
    );
  }

  const { summary, growth, category_breakdown, top_posts } = data;

  return (
    <HudFlyout
      title="성과 대시보드"
      subtitle={`기간: ${PERIOD_LABEL[period]} · 워밍업 ${summary.warmup_progress}`}
      headerAction={headerAction}
    >
      {/* KPI Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 6,
          marginBottom: 10,
        }}
      >
        {[
          { label: "포스트", value: summary.total_posts.toLocaleString() },
          { label: "조회수", value: summary.total_views.toLocaleString() },
          { label: "좋아요", value: summary.total_likes.toLocaleString() },
          { label: "댓글", value: summary.total_comments.toLocaleString() },
          { label: "리포스트", value: summary.total_reposts.toLocaleString() },
          { label: "참여율", value: `${summary.avg_engagement_rate.toFixed(2)}%` },
        ].map(({ label, value }) => (
          <div
            key={label}
            style={{
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(100,200,255,0.15)",
              borderRadius: 4,
              padding: "6px 8px",
            }}
          >
            <div style={{ fontSize: 9, color: "#8090b0", textTransform: "uppercase", marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ fontSize: 13, color: "#e0e8ff", fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Growth */}
      <div
        style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(100,200,255,0.1)",
          borderRadius: 4,
          padding: "6px 10px",
          marginBottom: 10,
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 9, color: "#8090b0", textTransform: "uppercase", marginRight: 4 }}>성장</span>
        <span style={{ fontSize: 9, color: "#8090b0" }}>조회 <GrowthBadge pct={growth.views_change_pct} /></span>
        <span style={{ fontSize: 9, color: "#8090b0" }}>좋아요 <GrowthBadge pct={growth.likes_change_pct} /></span>
        <span style={{ fontSize: 9, color: "#8090b0" }}>참여율 <GrowthBadge pct={growth.engagement_change_pct} /></span>
      </div>

      {/* Category Breakdown */}
      {category_breakdown.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: "#8090b0", textTransform: "uppercase", marginBottom: 6, fontWeight: 600 }}>
            카테고리별
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {category_breakdown.map((cat) => (
              <div
                key={cat.category}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(100,200,255,0.1)",
                  borderRadius: 4,
                  padding: "4px 8px",
                }}
              >
                <span style={{ fontSize: 10, color: "#e0e8ff", minWidth: 48 }}>{cat.category}</span>
                <span style={{ fontSize: 9, color: "#8090b0" }}>{cat.posts}개</span>
                <span style={{ fontSize: 9, color: "#8090b0", flex: 1 }}>
                  avg {cat.avg_views.toLocaleString()} views
                </span>
                <span style={{ fontSize: 9, color: "#4ecdc4" }}>{cat.engagement_rate.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Posts */}
      {top_posts.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: "#8090b0", textTransform: "uppercase", marginBottom: 6, fontWeight: 600 }}>
            TOP 포스트
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {top_posts.slice(0, 5).map((post, i) => (
              <div
                key={post.post_id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(100,200,255,0.1)",
                  borderRadius: 4,
                  padding: "5px 8px",
                }}
              >
                <span style={{ fontSize: 9, color: "var(--pixel-accent)", minWidth: 14, fontWeight: 700 }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: 10, color: "#e0e8ff", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {post.text_preview}
                </span>
                <span style={{ fontSize: 9, color: "#4ecdc4", flexShrink: 0 }}>
                  {post.views.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </HudFlyout>
  );
}
