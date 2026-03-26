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

  // Load rooms on mount
  useEffect(() => {
    fetchRooms();
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
    await fetch(`/api/chat/rooms/${selectedRoom.id}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: inviteAgent }),
    });
    setInviteAgent('');
    setShowInvite(false);
    fetchRooms();
  }

  const currentParticipants = selectedRoom?.participants ?? [];

  return (
    <HudFlyout title="BiniLab 채팅" subtitle="에이전트 대화방">
      <div style={{ display: 'flex', height: 520, overflow: 'hidden', minWidth: 600 }}>
        {/* Room list sidebar */}
        <div
          style={{
            width: 180,
            minWidth: 180,
            borderRight: '1px solid rgba(255,255,255,0.1)',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: '8px 10px',
              fontSize: 11,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            채팅방
          </div>

          {/* Create room button */}
          <div style={{ padding: '0 8px 8px' }}>
            <button
              type="button"
              onClick={() => setShowCreateForm(!showCreateForm)}
              style={{
                width: '100%',
                padding: '8px',
                background: 'rgba(78, 205, 196, 0.2)',
                border: '1px solid rgba(78, 205, 196, 0.4)',
                color: '#4ecdc4',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              + 새 채팅방
            </button>

            {showCreateForm && (
              <div
                style={{
                  marginTop: '6px',
                  padding: '8px',
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
                    padding: '5px',
                    background: '#1a1a2e',
                    color: '#e0e8ff',
                    border: '1px solid rgba(100,200,255,0.2)',
                    borderRadius: '3px',
                    fontSize: '12px',
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
                      padding: '5px',
                      background: '#1a1a2e',
                      color: '#e0e8ff',
                      border: '1px solid rgba(100,200,255,0.2)',
                      borderRadius: '3px',
                      fontSize: '12px',
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
                      padding: '5px',
                      background: '#4ecdc4',
                      color: '#000',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: newRoomType === 'dm' && !selectedAgent ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
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
                      padding: '5px',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#8090b0',
                      border: '1px solid rgba(100,200,255,0.15)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>

          {rooms.length === 0 ? (
            <div style={{ padding: '10px', fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>
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
                  padding: '10px 12px',
                  background: selectedRoom?.id === room.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                  border: 'none',
                  borderLeft: selectedRoom?.id === room.id ? '2px solid #FFD700' : '2px solid transparent',
                  cursor: 'pointer',
                  color: selectedRoom?.id === room.id ? '#fff' : 'rgba(255,255,255,0.6)',
                  fontSize: 13,
                  lineHeight: 1.3,
                }}
              >
                <div style={{ fontWeight: selectedRoom?.id === room.id ? 600 : 400, marginBottom: 2 }}>
                  {room.name}
                </div>
                {room.message_count > 0 && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
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
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderBottom: '1px solid rgba(100,200,255,0.15)',
                }}
              >
                <span style={{ fontWeight: 'bold', fontSize: '14px', color: '#fff' }}>
                  {selectedRoom.name}
                </span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setShowInvite(!showInvite)}
                    style={{
                      padding: '4px 10px',
                      background: 'rgba(78,205,196,0.2)',
                      border: '1px solid rgba(78,205,196,0.4)',
                      color: '#4ecdc4',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    초대하기
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteRoom}
                    style={{
                      padding: '4px 10px',
                      background: 'rgba(255,107,107,0.2)',
                      border: '1px solid rgba(255,107,107,0.4)',
                      color: '#ff6b6b',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    방 삭제
                  </button>
                </div>
              </div>

              {/* Invite inline form */}
              {showInvite && (
                <div
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(20,20,40,0.8)',
                    borderBottom: '1px solid rgba(100,200,255,0.1)',
                    display: 'flex',
                    gap: '6px',
                    alignItems: 'center',
                  }}
                >
                  <select
                    value={inviteAgent}
                    onChange={e => setInviteAgent(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '5px',
                      background: '#1a1a2e',
                      color: '#e0e8ff',
                      border: '1px solid rgba(100,200,255,0.2)',
                      borderRadius: '3px',
                      fontSize: '12px',
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
                      padding: '5px 12px',
                      background: inviteAgent ? '#4ecdc4' : 'rgba(78,205,196,0.2)',
                      color: inviteAgent ? '#000' : '#4ecdc4',
                      border: '1px solid rgba(78,205,196,0.4)',
                      borderRadius: '3px',
                      cursor: inviteAgent ? 'pointer' : 'not-allowed',
                      fontSize: '12px',
                    }}
                  >
                    추가
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowInvite(false)}
                    style={{
                      padding: '5px 10px',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#8090b0',
                      border: '1px solid rgba(100,200,255,0.15)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
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
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {messages.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 24 }}>
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
                            fontSize: 11,
                            color: color,
                            marginBottom: 3,
                            fontWeight: 600,
                          }}
                        >
                          {getAgentLabel(msg.sender)}
                        </div>
                        {/* Bubble */}
                        <div
                          style={{
                            maxWidth: '80%',
                            padding: '10px 14px',
                            borderRadius: isOwner ? '8px 2px 8px 8px' : '2px 8px 8px 8px',
                            background: isOwner
                              ? 'rgba(255,215,0,0.2)'
                              : 'rgba(255,255,255,0.08)',
                            border: `1px solid ${isOwner ? 'rgba(255,215,0,0.3)' : 'rgba(255,255,255,0.12)'}`,
                            fontSize: 13,
                            color: '#fff',
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
                  padding: '10px 14px',
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <input
                  type="text"
                  className="pixel-input"
                  style={{ flex: 1, height: 40, padding: '0 12px', fontSize: 14 }}
                  placeholder="메시지 입력..."
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                />
                <button
                  type="button"
                  className="pixel-icon-btn pixel-icon-btn--primary"
                  style={{ width: 40, height: 40, minWidth: 40 }}
                  onClick={handleSend}
                  disabled={sending || !newMessage.trim()}
                  title="전송"
                >
                  <SendHorizontal size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </HudFlyout>
  );
}
