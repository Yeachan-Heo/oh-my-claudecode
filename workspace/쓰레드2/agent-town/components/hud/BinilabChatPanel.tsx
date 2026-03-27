"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SendHorizontal } from "lucide-react";
import HudFlyout from "./HudFlyout";
import { BINILAB_AGENTS } from "@/lib/binilab-agents";
import { supabase } from "@/lib/supabase";

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

function getAgentName(id: string): string {
  const agent = BINILAB_AGENTS.find(a => a.id === id);
  return agent ? `${agent.name}(${agent.role})` : id;
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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRoomType, setNewRoomType] = useState<'dm' | 'meeting' | 'owner'>('dm');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [inviteAgent, setInviteAgent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  async function fetchRooms() {
    try {
      const res = await fetch('/api/chat/rooms');
      if (!res.ok) return;
      const json = await res.json();
      setRooms(json.rooms ?? []);
    } catch {
      // ignore
    }
  }

  // Load rooms on mount + Realtime for new rooms
  useEffect(() => {
    fetchRooms();

    const channel = supabase
      .channel('chat-rooms-updates')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_rooms' },
        () => { fetchRooms(); },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Load messages + Supabase Realtime subscription
  const loadMessages = useCallback(async () => {
    if (!selectedRoom) return;
    try {
      const res = await fetch(`/api/chat/rooms/${selectedRoom.id}/messages`);
      if (!res.ok) return;
      const json = await res.json();
      setMessages(json.messages ?? []);
    } catch {
      // ignore
    }
  }, [selectedRoom]);

  useEffect(() => {
    if (!selectedRoom) return;

    // Initial load
    loadMessages();

    // Supabase Realtime: listen for new messages in this room
    const channel = supabase
      .channel(`room-${selectedRoom.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_messages',
          filter: `room_id=eq.${selectedRoom.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          // Skip dispatch/system messages
          if (row.message_type === 'task_assign' || row.message_type === 'processed') return;
          setMessages((prev) => [
            ...prev,
            {
              id: row.id as string,
              sender: row.sender as string,
              message: row.message as string,
              message_type: (row.message_type as string) ?? 'chat',
              reply_to: (row.reply_to as string) ?? null,
              mentions: (row.mentions as string[]) ?? [],
              created_at: (row.created_at as string) ?? new Date().toISOString(),
            },
          ]);
        },
      )
      .subscribe();

    // Fallback polling every 30s (in case Realtime misses something)
    const fallback = setInterval(loadMessages, 30000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(fallback);
    };
  }, [selectedRoom, loadMessages]);

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
        // 에이전트 디스패치 (실패해도 메시지 전송은 성공)
        try {
          await fetch('/api/chat/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              room_id: selectedRoom.id,
              message: trimmed,
              sender: 'sihun-owner',
            }),
          });
        } catch {} // 디스패치 실패해도 메시지 전송은 성공
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

  async function handleCreateRoom() {
    const participants =
      newRoomType === 'dm'
        ? ['sihun-owner', selectedAgent]
        : ['sihun-owner'];

    const res = await fetch('/api/chat/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: newRoomType,
        name: newRoomType === 'dm' ? '' : `${newRoomType} 채팅방`,
        participants,
        created_by: 'sihun-owner',
      }),
    });

    if (res.ok) {
      setShowCreateForm(false);
      setSelectedAgent('');
      fetchRooms();
    }
  }

  async function handleDeleteRoom() {
    if (!selectedRoom) return;
    await fetch(`/api/chat/rooms/${selectedRoom.id}`, { method: 'DELETE' });
    setSelectedRoom(null);
    setShowInvite(false);
    fetchRooms();
  }

  async function handleInvite() {
    if (!selectedRoom || !inviteAgent) return;
    const res = await fetch(`/api/chat/rooms/${selectedRoom.id}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: inviteAgent }),
    });
    if (res.ok) {
      // Update local state immediately so participant list refreshes
      setSelectedRoom(prev => prev ? {
        ...prev,
        participants: [...(prev.participants || []), inviteAgent],
      } : null);
      setInviteAgent('');
      setShowInvite(false);
      // Also refresh rooms from server
      fetchRooms();
    }
  }

  const [panelSize, setPanelSize] = useState({ width: 440, height: 520 });

  const currentParticipants = selectedRoom?.participants ?? [];

  return (
    <HudFlyout title="BiniLab 채팅" subtitle="에이전트 대화방">
      {/* Override flyout width for chat panel */}
      <style>{`
        .hud-flyout:has(> .hud-flyout__body > [data-chat-panel]) {
          overflow: visible !important;
          width: auto !important;
          max-height: none !important;
        }
        .hud-topright-flyout:has([data-chat-panel]) {
          overflow: visible !important;
        }
      `}</style>
      <div
        data-chat-panel
        style={{
          display: 'flex',
          width: panelSize.width,
          height: panelSize.height,
          overflow: 'hidden',
          position: 'fixed',
          right: 8,
          top: 56,
          minWidth: 320,
          minHeight: 350,
          maxWidth: '90vw',
          maxHeight: '85vh',
          background: 'rgba(10, 10, 20, 0.95)',
          borderRadius: '8px',
          border: '1px solid rgba(100, 200, 255, 0.15)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          zIndex: 100,
        }}
      >
        {/* Left edge resize handle — 왼쪽으로 늘리기 */}
        <div
          style={{
            position: 'absolute',
            left: -3,
            top: 0,
            width: 6,
            height: '100%',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = panelSize.width;
            const onMove = (ev: MouseEvent) => {
              setPanelSize(prev => ({ ...prev, width: Math.max(320, Math.min(800, startW - (ev.clientX - startX))) }));
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
        {/* Bottom edge resize handle */}
        <div
          style={{
            position: 'absolute',
            bottom: -3,
            left: 0,
            width: '100%',
            height: 6,
            cursor: 'ns-resize',
            zIndex: 10,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = panelSize.height;
            const onMove = (ev: MouseEvent) => {
              setPanelSize(prev => ({ ...prev, height: Math.max(350, Math.min(window.innerHeight * 0.85, startH + (ev.clientY - startY))) }));
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
        {/* Bottom-left corner resize handle — 왼쪽 아래 대각선 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: 16,
            height: 16,
            cursor: 'nesw-resize',
            zIndex: 11,
            background: 'linear-gradient(225deg, transparent 50%, rgba(100,200,255,0.3) 50%)',
            borderRadius: '0 0 0 8px',
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = panelSize.width;
            const startH = panelSize.height;
            const onMouseMove = (ev: MouseEvent) => {
              const newW = Math.max(320, Math.min(800, startW - (ev.clientX - startX)));
              const newH = Math.max(350, Math.min(window.innerHeight * 0.85, startH + (ev.clientY - startY)));
              setPanelSize({ width: newW, height: newH });
            };
            const onMouseUp = () => {
              document.removeEventListener('mousemove', onMouseMove);
              document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
          }}
        />
        {/* Room list sidebar */}
        <div
          style={{
            width: 170,
            minWidth: 170,
            borderRight: '1px solid rgba(255,255,255,0.1)',
            overflowY: 'auto',
            overflowX: 'hidden',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              fontSize: 12,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            채팅방
          </div>

          {/* Create room button */}
          <div style={{ padding: '0 10px 10px' }}>
            <button
              type="button"
              onClick={() => setShowCreateForm(!showCreateForm)}
              style={{
                width: '100%',
                padding: '9px',
                background: 'rgba(78, 205, 196, 0.2)',
                border: '1px solid rgba(78, 205, 196, 0.4)',
                color: '#4ecdc4',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              + 새 채팅방
            </button>

            {showCreateForm && (
              <div
                style={{
                  marginTop: '6px',
                  padding: '10px',
                  background: 'rgba(20,20,40,0.8)',
                  borderRadius: '4px',
                  border: '1px solid rgba(100,200,255,0.15)',
                }}
              >
                <select
                  value={newRoomType}
                  onChange={e => setNewRoomType(e.target.value as 'dm' | 'meeting' | 'owner')}
                  style={{
                    width: '100%',
                    marginBottom: '6px',
                    padding: '6px',
                    background: '#1a1a2e',
                    color: '#e0e8ff',
                    border: '1px solid rgba(100,200,255,0.2)',
                    borderRadius: '3px',
                    fontSize: '13px',
                  }}
                >
                  <option value="dm">1:1 DM</option>
                  <option value="meeting">회의</option>
                  <option value="owner">오너 채널</option>
                </select>

                {newRoomType === 'dm' && (
                  <select
                    value={selectedAgent}
                    onChange={e => setSelectedAgent(e.target.value)}
                    style={{
                      width: '100%',
                      marginBottom: '6px',
                      padding: '6px',
                      background: '#1a1a2e',
                      color: '#e0e8ff',
                      border: '1px solid rgba(100,200,255,0.2)',
                      borderRadius: '3px',
                      fontSize: '13px',
                    }}
                  >
                    <option value="">에이전트 선택...</option>
                    {BINILAB_AGENTS.filter(a => a.id !== 'sihun-owner').map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                )}

                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    onClick={handleCreateRoom}
                    disabled={newRoomType === 'dm' && !selectedAgent}
                    style={{
                      flex: 1,
                      padding: '6px',
                      background: '#4ecdc4',
                      color: '#000',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: newRoomType === 'dm' && !selectedAgent ? 'not-allowed' : 'pointer',
                      fontSize: '13px',
                      opacity: newRoomType === 'dm' && !selectedAgent ? 0.5 : 1,
                    }}
                  >
                    만들기
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreateForm(false)}
                    style={{
                      flex: 1,
                      padding: '6px',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#8090b0',
                      border: '1px solid rgba(100,200,255,0.15)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>

          {rooms.length === 0 ? (
            <div style={{ padding: '12px', fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>
              채팅방 없음
            </div>
          ) : (
            rooms.map(room => (
              <button
                key={room.id}
                type="button"
                onClick={() => { setSelectedRoom(room); setShowInvite(false); }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  background: selectedRoom?.id === room.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                  border: 'none',
                  borderLeft: selectedRoom?.id === room.id ? '2px solid #FFD700' : '2px solid transparent',
                  cursor: 'pointer',
                  color: selectedRoom?.id === room.id ? '#fff' : 'rgba(255,255,255,0.6)',
                  fontSize: 14,
                  lineHeight: 1.3,
                }}
              >
                <div style={{ fontWeight: selectedRoom?.id === room.id ? 600 : 400, marginBottom: 2 }}>
                  {room.name}
                </div>
                {room.message_count > 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                    {room.message_count}개 메시지
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {/* Message area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {!selectedRoom ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.3)',
                fontSize: 14,
              }}
            >
              채팅방을 선택하세요
            </div>
          ) : (
            <>
              {/* Room header */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  borderBottom: '1px solid rgba(100,200,255,0.15)',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontWeight: 'bold', fontSize: '15px', color: '#fff' }}>
                  {selectedRoom.name}
                </span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setShowInvite(!showInvite)}
                    style={{
                      padding: '5px 11px',
                      background: 'rgba(78,205,196,0.2)',
                      border: '1px solid rgba(78,205,196,0.4)',
                      color: '#4ecdc4',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    초대하기
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteRoom}
                    style={{
                      padding: '5px 11px',
                      background: 'rgba(255,107,107,0.2)',
                      border: '1px solid rgba(255,107,107,0.4)',
                      color: '#ff6b6b',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    방 삭제
                  </button>
                </div>
              </div>

              {/* Participants */}
              {selectedRoom && (
                <div style={{ padding: '5px 14px', fontSize: '12px', color: '#8090b0', borderBottom: '1px solid rgba(100,200,255,0.1)', flexShrink: 0 }}>
                  참여자: {currentParticipants.map(p => getAgentName(p)).join(', ')}
                </div>
              )}

              {/* Invite inline form */}
              {showInvite && (
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(20,20,40,0.8)',
                    borderBottom: '1px solid rgba(100,200,255,0.1)',
                    display: 'flex',
                    gap: '6px',
                    alignItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <select
                    value={inviteAgent}
                    onChange={e => setInviteAgent(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '6px',
                      background: '#1a1a2e',
                      color: '#e0e8ff',
                      border: '1px solid rgba(100,200,255,0.2)',
                      borderRadius: '3px',
                      fontSize: '13px',
                    }}
                  >
                    <option value="">에이전트 선택...</option>
                    {BINILAB_AGENTS.filter(
                      a => a.id !== 'sihun-owner' && !currentParticipants.includes(a.id)
                    ).map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleInvite}
                    disabled={!inviteAgent}
                    style={{
                      padding: '6px 14px',
                      background: inviteAgent ? '#4ecdc4' : 'rgba(78,205,196,0.2)',
                      color: inviteAgent ? '#000' : '#4ecdc4',
                      border: '1px solid rgba(78,205,196,0.4)',
                      borderRadius: '3px',
                      cursor: inviteAgent ? 'pointer' : 'not-allowed',
                      fontSize: '13px',
                    }}
                  >
                    추가
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowInvite(false)}
                    style={{
                      padding: '6px 11px',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#8090b0',
                      border: '1px solid rgba(100,200,255,0.15)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    취소
                  </button>
                </div>
              )}

              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 11,
                  minHeight: 0,
                }}
              >
                {messages.length === 0 ? (
                  <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 24 }}>
                    메시지 없음
                  </div>
                ) : (
                  messages.map(msg => {
                    const isOwner = msg.sender === 'sihun-owner';
                    const isDirective = msg.message_type === 'directive';
                    const color = getAgentColor(msg.sender);
                    return (
                      <div
                        key={msg.id}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: isOwner ? 'flex-end' : 'flex-start',
                          ...(isDirective && {
                            backgroundColor: '#e8f4fd',
                            borderLeft: '3px solid #2196F3',
                            padding: '8px 12px',
                            borderRadius: '4px',
                          }),
                        }}
                      >
                        {/* Sender label */}
                        <div
                          style={{
                            fontSize: 12,
                            color: isDirective ? '#1565C0' : color,
                            marginBottom: 3,
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          {getAgentLabel(msg.sender)}
                          {isDirective && (
                            <span style={{
                              fontSize: 10,
                              color: '#1976D2',
                              backgroundColor: '#BBDEFB',
                              padding: '1px 6px',
                              borderRadius: 3,
                              marginLeft: 6,
                              fontWeight: 'bold',
                            }}>
                              CEO 지시
                            </span>
                          )}
                        </div>
                        {/* Bubble */}
                        <div
                          style={{
                            maxWidth: '80%',
                            padding: '11px 16px',
                            borderRadius: isOwner ? '8px 2px 8px 8px' : '2px 8px 8px 8px',
                            background: isDirective
                              ? 'rgba(33,150,243,0.12)'
                              : isOwner
                                ? 'rgba(255,215,0,0.2)'
                                : 'rgba(255,255,255,0.08)',
                            border: isDirective
                              ? '1px solid rgba(33,150,243,0.35)'
                              : `1px solid ${isOwner ? 'rgba(255,215,0,0.3)' : 'rgba(255,255,255,0.12)'}`,
                            fontSize: isDirective ? 15 : 14,
                            color: isDirective ? '#e8f4fd' : '#fff',
                            lineHeight: 1.5,
                            wordBreak: 'break-word',
                          }}
                        >
                          {msg.message}
                        </div>
                        {/* Time */}
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 3 }}>
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
                  gap: 8,
                  padding: '12px 16px',
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                  flexShrink: 0,
                }}
              >
                <input
                  type="text"
                  className="pixel-input"
                  style={{ flex: 1, height: 44, padding: '0 14px', fontSize: 15 }}
                  placeholder="메시지 입력..."
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                />
                <button
                  type="button"
                  className="pixel-icon-btn pixel-icon-btn--primary"
                  style={{ width: 44, height: 44, minWidth: 44 }}
                  onClick={handleSend}
                  disabled={sending || !newMessage.trim()}
                  title="전송"
                >
                  <SendHorizontal size={18} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </HudFlyout>
  );
}
