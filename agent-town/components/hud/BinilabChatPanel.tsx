"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import HudFlyout from "./HudFlyout";
import { BINILAB_AGENTS } from "@/lib/binilab-agents";

interface ChatRoom {
  id: string;
  name: string;
  type: string;
  last_message_at: string | null;
  message_count: number;
  participants: string[];
}

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  message_type: string;
  reply_to: string | null;
  mentions: string[];
  created_at: string;
}

function getAgentColor(agentId: string): string {
  const agent = BINILAB_AGENTS.find(a => a.id === agentId);
  return agent?.avatarColor ?? '#888888';
}

function getAgentLabel(agentId: string): string {
  const agent = BINILAB_AGENTS.find(a => a.id === agentId);
  if (!agent) return agentId;
  return `${agent.name} (${agent.role})`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function BinilabChatPanel() {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load rooms on mount
  useEffect(() => {
    async function loadRooms() {
      try {
        const res = await fetch('/api/chat/rooms');
        if (!res.ok) return;
        const json = await res.json();
        setRooms(json.rooms ?? []);
      } catch {
        // ignore
      }
    }
    loadRooms();
  }, []);

  // Load messages when room is selected, auto-refresh every 5s
  useEffect(() => {
    if (!selectedRoom) return;

    async function loadMessages() {
      if (!selectedRoom) return;
      try {
        const res = await fetch(`/api/chat/rooms/${selectedRoom.id}/messages`);
        if (!res.ok) return;
        const json = await res.json();
        setMessages(json.messages ?? []);
      } catch {
        // ignore
      }
    }

    loadMessages();
    const interval = setInterval(loadMessages, 5000);
    return () => clearInterval(interval);
  }, [selectedRoom]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleSend() {
    const trimmed = newMessage.trim();
    if (!trimmed || !selectedRoom || sending) return;

    setSending(true);
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: selectedRoom.id,
          sender: 'sihun-owner',
          message: trimmed,
          message_type: 'chat',
        }),
      });
      if (res.ok) {
        setNewMessage('');
        // Reload messages
        const msgRes = await fetch(`/api/chat/rooms/${selectedRoom.id}/messages`);
        if (msgRes.ok) {
          const json = await msgRes.json();
          setMessages(json.messages ?? []);
        }
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <HudFlyout title="BiniLab 채팅" subtitle="에이전트 대화방">
      <div style={{ display: 'flex', height: 420, overflow: 'hidden' }}>
        {/* Room list sidebar */}
        <div
          style={{
            width: 140,
            borderRight: '1px solid rgba(255,255,255,0.1)',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: '6px 8px',
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            채팅방
          </div>
          {rooms.length === 0 ? (
            <div style={{ padding: '8px', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
              채팅방 없음
            </div>
          ) : (
            rooms.map(room => (
              <button
                key={room.id}
                type="button"
                onClick={() => setSelectedRoom(room)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 8px',
                  background: selectedRoom?.id === room.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                  border: 'none',
                  borderLeft: selectedRoom?.id === room.id ? '2px solid #FFD700' : '2px solid transparent',
                  cursor: 'pointer',
                  color: selectedRoom?.id === room.id ? '#fff' : 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  lineHeight: 1.3,
                }}
              >
                <div style={{ fontWeight: selectedRoom?.id === room.id ? 600 : 400, marginBottom: 2 }}>
                  {room.name}
                </div>
                {room.message_count > 0 && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                    {room.message_count}개 메시지
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {/* Message area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selectedRoom ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.3)',
                fontSize: 13,
              }}
            >
              채팅방을 선택하세요
            </div>
          ) : (
            <>
              {/* Room header */}
              <div
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.1)',
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.7)',
                  fontWeight: 600,
                }}
              >
                {selectedRoom.name}
              </div>

              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '8px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {messages.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 20 }}>
                    메시지 없음
                  </div>
                ) : (
                  messages.map(msg => {
                    const isOwner = msg.sender === 'sihun-owner';
                    const color = getAgentColor(msg.sender);
                    return (
                      <div
                        key={msg.id}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: isOwner ? 'flex-end' : 'flex-start',
                        }}
                      >
                        {/* Sender label */}
                        <div
                          style={{
                            fontSize: 10,
                            color: color,
                            marginBottom: 2,
                            fontWeight: 600,
                          }}
                        >
                          {getAgentLabel(msg.sender)}
                        </div>
                        {/* Bubble */}
                        <div
                          style={{
                            maxWidth: '80%',
                            padding: '6px 10px',
                            borderRadius: isOwner ? '8px 2px 8px 8px' : '2px 8px 8px 8px',
                            background: isOwner
                              ? 'rgba(255,215,0,0.2)'
                              : 'rgba(255,255,255,0.08)',
                            border: `1px solid ${isOwner ? 'rgba(255,215,0,0.3)' : 'rgba(255,255,255,0.12)'}`,
                            fontSize: 12,
                            color: '#fff',
                            lineHeight: 1.4,
                            wordBreak: 'break-word',
                          }}
                        >
                          {msg.message}
                        </div>
                        {/* Time */}
                        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>
                          {formatTime(msg.created_at)}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '8px 12px',
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <input
                  type="text"
                  className="pixel-input"
                  style={{ flex: 1, height: 36, padding: '0 10px', fontSize: 12 }}
                  placeholder="메시지 입력..."
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                />
                <button
                  type="button"
                  className="pixel-icon-btn pixel-icon-btn--primary"
                  style={{ width: 36, height: 36, minWidth: 36 }}
                  onClick={handleSend}
                  disabled={sending || !newMessage.trim()}
                  title="전송"
                >
                  <SendHorizontal size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </HudFlyout>
  );
}
