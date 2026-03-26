"use client";

import { FileText, TrendingUp, Clock } from "lucide-react";
import { STATUS_LABELS } from "@/lib/constants";
import type { ConnectionStatus } from "@/types/game";

// 비즈니스 KPI placeholder 값 (추후 API 연동)
const WARMUP_CURRENT = 19;
const WARMUP_TARGET = 20;
const POSTS_TODAY = 1;
const POSTS_TARGET = 3;
const PENDING_APPROVALS = 0;

interface BottomBarProps {
  connection: ConnectionStatus;
}

export default function BottomBar({ connection }: BottomBarProps) {
  const warmupPct = Math.round((WARMUP_CURRENT / WARMUP_TARGET) * 100);

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
          포스트 {POSTS_TODAY}/{POSTS_TARGET}
        </span>
      </div>

      {/* 워밍업 진행률 */}
      <div className="hud-pill hud-pill--metric">
        <TrendingUp size={10} />
        <span>
          워밍업 {WARMUP_CURRENT}/{WARMUP_TARGET} ({warmupPct}%)
        </span>
      </div>

      {/* 승인 대기 */}
      <div
        className={`hud-pill ${PENDING_APPROVALS > 0 ? "hud-pill--warning" : "hud-pill--metric"}`}
      >
        <Clock size={10} />
        <span>승인 대기 {PENDING_APPROVALS}</span>
      </div>
    </div>
  );
}
