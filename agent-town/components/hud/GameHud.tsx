"use client";

import "./hud.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useStudio } from "@/lib/store";
import { isVisibleChatMessage } from "@/lib/constants";
import { MAIN_SESSION_KEY } from "@/lib/reducer";
import { useBgm } from "@/lib/useBgm";
import { loadOnboardingDone, loadGatewayConfig, saveOnboardingDone } from "@/lib/persistence";
import type { HudDockItem, HudPanelId } from "./HudDock";
import TopBar from "./TopBar";
import BottomBar from "./BottomBar";
import ConnectionPanel from "./ConnectionPanel";
import ChatPanel from "./ChatPanel";
import TaskPanel from "./TaskPanel";
import WorkerPanel from "./WorkerPanel";
import DashboardPanel from "./DashboardPanel";
import AlertPanel from "./AlertPanel";
import BinilabChatPanel from "./BinilabChatPanel";
import SeatManagerModal from "./SeatManagerModal";
import MusicControls from "./MusicControls";
import OnboardingOverlay from "./OnboardingOverlay";

export default function GameHud() {
  const { state } = useStudio();
  const bgm = useBgm();
  const [openPanel, setOpenPanel] = useState<HudPanelId | null>(null);
  const [seatManagerOpen, setSeatManagerOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(
    () => !loadOnboardingDone() && !loadGatewayConfig(),
  );

  // Auto-dismiss onboarding when connection panel opens
  useEffect(() => {
    if (showOnboarding && openPanel === "connection") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to panel open
      setShowOnboarding(false);
      saveOnboardingDone();
    }
  }, [showOnboarding, openPanel]);

  // Auto-open connection panel on auth/connection failures
  useEffect(() => {
    if (
      state.connection === "auth_failed" ||
      state.connection === "unreachable" ||
      state.connection === "rate_limited"
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to connection state
      setOpenPanel("connection");
    } else if (state.connection === "connected") {
      setOpenPanel((prev) => (prev === "connection" ? null : prev));
    }
  }, [state.connection]);

  const activeSessionKey = state.activeSessionKey ?? MAIN_SESSION_KEY;
  const visibleTasks = useMemo(
    () => state.tasks.filter((task) => task.sessionKey === activeSessionKey),
    [activeSessionKey, state.tasks],
  );
  const visibleMessages = useMemo(
    () =>
      state.chatMessages.filter(
        (message) => message.sessionKey === activeSessionKey && isVisibleChatMessage(message),
      ),
    [activeSessionKey, state.chatMessages],
  );

  // Top-right toolbar items (everything except chat)
  const toolItems: HudDockItem[] = useMemo(
    () => [
      {
        id: "music",
        label: "Music",
        icon: "/ui/icons/icon-music.png",
        iconActive: "/ui/icons/icon-music-active.png",
      },
      {
        id: "connection",
        label: "Connection",
        icon: "/ui/icons/icon-connection.png",
        iconActive: "/ui/icons/icon-connection-active.png",
      },
      {
        id: "tasks",
        label: "Tasks",
        icon: "/ui/icons/icon-tasks.png",
        iconActive: "/ui/icons/icon-tasks-active.png",
      },
      {
        id: "workers",
        label: "Employees",
        icon: "/ui/icons/icon-workers.png",
        iconActive: "/ui/icons/icon-workers-active.png",
      },
      {
        id: "dashboard",
        label: "Dashboard",
        icon: "/ui/icons/icon-tasks.png",
        iconActive: "/ui/icons/icon-tasks-active.png",
      },
      {
        id: "alerts",
        label: "Alerts",
        icon: "/ui/icons/icon-connection.png",
        iconActive: "/ui/icons/icon-connection-active.png",
      },
      {
        id: "agentChat",
        label: "Agent Chat",
        icon: "/ui/icons/icon-workers.png",
        iconActive: "/ui/icons/icon-workers-active.png",
      },
    ],
    [],
  );

  const togglePanel = useCallback((id: HudPanelId) => {
    if (id === "workers") {
      setSeatManagerOpen((prev) => !prev);
      return;
    }
    setOpenPanel((current) => (current === id ? null : id));
  }, []);

  const musicIconOverrides = useMemo(
    () => (bgm.volume <= 0 ? { music: "/ui/icons/icon-music-muted.png" as string } : undefined),
    [bgm.volume],
  );

  const topRightPanelOpen = openPanel && openPanel !== "chat";

  return (
    <div className="hud-overlay">
      {/* Top area: logo | agent pills | tool buttons */}
      <TopBar
        seats={state.seats}
        toolItems={toolItems}
        openPanel={openPanel}
        onToggle={togglePanel}
        iconOverrides={musicIconOverrides}
      />

      {/* Top-right flyout panels */}
      {topRightPanelOpen && (
        <div className="hud-topright-flyout">
          {openPanel === "music" ? <MusicControls bgm={bgm} /> : null}
          {openPanel === "connection" ? <ConnectionPanel /> : null}
          {openPanel === "tasks" ? <TaskPanel tasks={visibleTasks} /> : null}
          {openPanel === "workers" ? (
            <WorkerPanel seats={state.seats} onOpenManager={() => setSeatManagerOpen(true)} />
          ) : null}
          {openPanel === "dashboard" ? <DashboardPanel /> : null}
          {openPanel === "alerts" ? <AlertPanel /> : null}
          {openPanel === "agentChat" ? <BinilabChatPanel /> : null}
        </div>
      )}

      {/* Bottom area: status pills (left) + chat dock (right) */}
      <div className="layout-bottom">
        <BottomBar
          connection={state.connection}
          sessionMetrics={state.sessionMetrics}
          seats={state.seats}
        />

        {/* Spacer pushes chat to right */}
        <div style={{ flex: "1 1 auto" }} />

        {/* Chat dock */}
        <div className="hud-chat-dock">
          {openPanel === "chat" && (
            <div className="hud-chat-dock__panel">
              <ChatPanel
                messages={visibleMessages}
                tasks={visibleTasks}
                isConnected={state.connection === "connected"}
                sessions={state.sessions}
                activeSessionKey={state.activeSessionKey}
              />
            </div>
          )}
          <button
            type="button"
            className={`hud-chat-dock__btn ${openPanel === "chat" ? "hud-chat-dock__btn--active" : ""}`}
            onClick={() => togglePanel("chat")}
            title="Chat"
          >
            <img
              src={
                openPanel === "chat" ? "/ui/icons/icon-chat-active.png" : "/ui/icons/icon-chat.png"
              }
              alt="Chat"
              width={28}
              height={28}
              style={{ imageRendering: "pixelated" }}
            />
            <span className="hud-chat-dock__label">Chat</span>
          </button>
        </div>
      </div>

      {/* Modals */}
      <SeatManagerModal
        open={seatManagerOpen}
        onClose={() => setSeatManagerOpen(false)}
        seats={state.seats}
      />

      {showOnboarding && <OnboardingOverlay onDone={() => setShowOnboarding(false)} />}
    </div>
  );
}
