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

  async function reloadMessages() {
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

  async function simulateAgentReply(roomId: string, participants: string[]) {
    const otherAgents = participants.filter(p => p !== 'sihun-owner');
    if (otherAgents.length === 0) return;

    const responder = otherAgents[0];
    const agent = BINILAB_AGENTS.find(a => a.id === responder);
    if (!agent) return;

    await new Promise(r => setTimeout(r, 1500));

    const replies: Record<string, string[]> = {
      'CEO': ['네, 확인했습니다. 데이터 기반으로 판단하겠습니다.', '알겠습니다. 다음 스탠드업에서 논의하죠.'],
      '분석팀장': ['데이터를 확인해볼게요. 잠시만요.', '분석 결과를 공유해드릴게요.'],
      '뷰티 크리에이터': ['넹! 바로 확인할게요 ㅋㅋ', '오 좋은 아이디어에요! 반영해볼게요~'],
      '품질검수관': ['QA 관점에서 확인해보겠습니다.', '체크리스트 기준으로 검토할게요.'],
      '트렌드헌터': ['오 이거 재밌는 거 찾았어요!', '트렌드 데이터 확인해볼게요.'],
      '엔지니어': ['기술적으로 확인해보겠습니다.', '시스템 상태 체크해볼게요.'],
      '마케팅팀장': ['다들 의견 모아볼까요~', '마케팅 관점에서 검토할게요.'],
      '건강 에디터': ['건강 카테고리로 확인해볼게요!', '관련 포스트 찾아볼게요.'],
      '생활 에디터': ['생활 팁으로 풀어볼게요!', '네 바로 작업할게요~'],
      '다이어트 에디터': ['다이어트 관련 소재 볼게요!', '확인했어요! 바로 할게요.'],
    };

    const roleReplies = replies[agent.role] || ['네, 확인했습니다.'];
    const reply = roleReplies[Math.floor(Math.random() * roleReplies.length)];

    await fetch('/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId,
        sender: responder,
        message: reply,
        message_type: 'report',
      }),
    });

    // Force refresh messages after agent reply
    setTimeout(() => reloadMessages(), 500);
  }

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
        // Trigger auto-reply from participants
        const participants = selectedRoom.participants || [];
        simulateAgentReply(selectedRoom.id, participants);
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
      {/* Override flyout width for chat panel */}
      <style>{`
        .hud-flyout:has(> .hud-flyout__body > [data-chat-panel]) {
          width: min(480px, calc(100vw - 60px)) !important;
          max-height: 70vh !important;
        }
      `}</style>
      <div data-chat-panel style={{ display: 'flex', height: 560, overflow: 'hidden', maxWidth: '480px', maxHeight: '70vh' }}>
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
                            fontSize: 12,
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
                            padding: '11px 16px',
                            borderRadius: isOwner ? '8px 2px 8px 8px' : '2px 8px 8px 8px',
                            background: isOwner
                              ? 'rgba(255,215,0,0.2)'
                              : 'rgba(255,255,255,0.08)',
                            border: `1px solid ${isOwner ? 'rgba(255,215,0,0.3)' : 'rgba(255,255,255,0.12)'}`,
                            fontSize: 14,
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
