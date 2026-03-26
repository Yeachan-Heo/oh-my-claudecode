"use client";

import Image from "next/image";

export type HudPanelId = "connection" | "chat" | "tasks" | "workers" | "music" | "dashboard" | "alerts" | "agentChat";

export interface HudDockItem {
  id: HudPanelId;
  label: string;
  icon: string;
  iconActive: string;
}

interface HudDockProps {
  items: HudDockItem[];
  openPanel: HudPanelId | null;
  onToggle: (id: HudPanelId) => void;
  iconOverrides?: Partial<Record<HudPanelId, string>>;
}

export default function HudDock({ items, openPanel, onToggle, iconOverrides }: HudDockProps) {
  return (
    <div className="hud-dock-wrapper">
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 2 }}>
        {items.map((item) => {
          const active = openPanel === item.id;
          const override = iconOverrides?.[item.id];
          const src = override ?? (active ? item.iconActive : item.icon);
          return (
            <button
              key={item.id}
              type="button"
              data-dock-id={item.id}
              onClick={() => onToggle(item.id)}
              title={item.label}
              className={active ? "hud-dock-btn hud-dock-btn--active" : "hud-dock-btn"}
              style={{
                display: "block",
                width: 36,
                height: 36,
                padding: 0,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                imageRendering: "pixelated",
                transition: "transform 0.1s, filter 0.1s",
                transform: active ? "scale(1.05)" : undefined,
              }}
            >
              <Image
                src={src}
                alt={item.label}
                width={32}
                height={32}
                style={{ imageRendering: "pixelated", display: "block" }}
                unoptimized
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
