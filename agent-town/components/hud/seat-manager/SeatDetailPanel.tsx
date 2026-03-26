"use client";

import type { SeatState, SeatType, AgentConfig } from "@/types/game";
import CharacterPortrait from "../CharacterPortrait";
import SpritePreview from "./SpritePreview";

const ROLE_PRESETS = [
  "CEO",
  "분석팀장",
  "뷰티 크리에이터",
  "품질검수관",
  "트렌드헌터",
  "엔지니어",
  "마케팅팀장",
  "건강 에디터",
  "생활 에디터",
  "다이어트 에디터",
  "오너",
];

function seatStateLabel(seat: SeatState) {
  if (!seat.assigned) return "vacant";
  if (seat.status === "empty") return "idle";
  return seat.status;
}

export interface SeatDetailPanelProps {
  selectedSeat: SeatState;
  effectiveName: string;
  effectiveRoleTitle: string;
  effectiveSpriteKey: string;
  effectiveSpritePath: string;
  effectiveSeatType: SeatType;
  effectiveAgentConfig: AgentConfig | undefined;
  busy: boolean;
  canSave: boolean;
  agentsLoading: boolean;
  discoveredAgents: AgentConfig[];
  usedAgentIds: Set<string>;
  onNameChange: (value: string) => void;
  onRoleTitleChange: (value: string) => void;
  onSpriteSelect: (spriteKey: string, spritePath: string, spriteLabel: string) => void;
  onSelectAgent: (agent: AgentConfig) => void;
  onSave: () => void;
  onUnassign: () => void;
  onClose: () => void;
  isAuggie?: boolean;
}

export default function SeatDetailPanel({
  selectedSeat,
  effectiveName,
  effectiveRoleTitle,
  effectiveSpriteKey,
  effectiveSpritePath,
  effectiveSeatType,
  effectiveAgentConfig,
  busy,
  canSave,
  agentsLoading,
  discoveredAgents,
  usedAgentIds,
  onNameChange,
  onRoleTitleChange,
  onSpriteSelect,
  onSelectAgent,
  onSave,
  onUnassign,
  onClose,
  isAuggie,
}: SeatDetailPanelProps) {
  return (
    <div
      style={{
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 12 }}>
        <div className="seat-manager__portrait-frame seat-manager__portrait-frame--large">
          {effectiveSpritePath ? (
            <CharacterPortrait
              spritePath={effectiveSpritePath}
              name={effectiveName || "Crew preview"}
              large
            />
          ) : (
            <div style={{ fontSize: 8, color: "var(--pixel-muted)" }}>No character assigned</div>
          )}
        </div>

        <div className="hud-panel__stack" style={{ gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 12 }}>
                {selectedSeat.assigned ? effectiveName || selectedSeat.label : "Vacant Seat"}
              </div>
              <div style={{ fontSize: 8, color: "var(--pixel-muted)", marginTop: 4 }}>
                {selectedSeat.seatId} · facing {selectedSeat.spawnFacing ?? "down"}
                {effectiveSeatType === "agent" && effectiveAgentConfig && (
                  <span style={{ color: "var(--pixel-accent)", marginLeft: 6 }}>
                    agent:{effectiveAgentConfig.agentId}
                  </span>
                )}
              </div>
            </div>
            <div
              style={{
                fontSize: 7,
                padding: "4px 8px",
                background: "rgba(255,255,255,0.06)",
                color: selectedSeat.assigned ? "var(--pixel-text)" : "var(--pixel-muted)",
              }}
            >
              {seatStateLabel(selectedSeat)}
            </div>
          </div>

          {/* Name + (Agent selector) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: effectiveSeatType === "agent" ? "1fr 1fr" : "1fr",
              gap: 8,
            }}
          >
            <div>
              <label className="hud-panel__label">Name</label>
              <input
                className="pixel-input hud-panel__input"
                value={effectiveName}
                onChange={(event) => onNameChange(event.target.value)}
                disabled={busy}
                placeholder="Crew name"
                style={{ minHeight: 0 }}
              />
            </div>
            {effectiveSeatType === "agent" && (
              <div>
                <label className="hud-panel__label">Agent</label>
                {agentsLoading ? (
                  <div
                    className="pixel-input hud-panel__input"
                    style={{
                      minHeight: 0,
                      display: "flex",
                      alignItems: "center",
                      fontSize: 8,
                      color: "var(--pixel-muted)",
                    }}
                  >
                    Scanning...
                  </div>
                ) : discoveredAgents.length === 0 ? (
                  <div
                    className="pixel-input hud-panel__input"
                    style={{
                      minHeight: 0,
                      display: "flex",
                      alignItems: "center",
                      fontSize: 8,
                      color: "var(--pixel-muted)",
                    }}
                  >
                    {isAuggie ? "Auggie" : "No agents found"}
                  </div>
                ) : (
                  <select
                    className="pixel-input hud-panel__input"
                    style={{ minHeight: 0 }}
                    value={effectiveAgentConfig?.agentId ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const agent = discoveredAgents.find((a) => a.agentId === e.target.value);
                      if (agent) onSelectAgent(agent);
                    }}
                  >
                    <option value="">-- select --</option>
                    {discoveredAgents.map((agent) => {
                      const isUsed = usedAgentIds.has(agent.agentId);
                      const label = `${agent.identity?.emoji ?? "◆"} ${agent.identity?.name ?? agent.agentId}`;
                      return (
                        <option key={agent.agentId} value={agent.agentId} disabled={isUsed}>
                          {isUsed ? `${label} (assigned)` : label}
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>
            )}
          </div>
          <div>
            <label className="hud-panel__label">Role / Title</label>
            <input
              className="pixel-input hud-panel__input"
              value={effectiveRoleTitle}
              onChange={(event) => onRoleTitleChange(event.target.value)}
              disabled={busy}
              placeholder="Role title"
              style={{ minHeight: 0 }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {ROLE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="pixel-button"
                  style={{ fontSize: 7, padding: "4px 6px" }}
                  disabled={busy}
                  onClick={() => onRoleTitleChange(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="seat-hint">
        {busy
          ? "This seat is currently active. Finish or stop the task before changing crew assignment."
          : effectiveSeatType === "agent"
            ? isAuggie
              ? "Agent seats are not supported with the Auggie provider. Switch to Worker mode to assign tasks."
              : "Select an OpenClaw agent, choose a portrait, then save. Agents have their own workspace and session."
            : "Select a portrait, set name and role, then save. Workers execute tasks from the main agent."}
      </div>

      <SpritePreview
        selectedSpriteKey={effectiveSpriteKey}
        busy={busy}
        onSelectSprite={onSpriteSelect}
      />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          className="pixel-button"
          onClick={onUnassign}
          disabled={!selectedSeat.assigned || busy}
        >
          Unassign
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="pixel-button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="pixel-button pixel-button--primary"
            onClick={onSave}
            disabled={!canSave}
          >
            {selectedSeat.assigned
              ? "Save Changes"
              : effectiveSeatType === "agent"
                ? "Assign Agent"
                : "Assign Character"}
          </button>
        </div>
      </div>
    </div>
  );
}
