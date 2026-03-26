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

  function generateContextualReply(agent: typeof BINILAB_AGENTS[0], userMessage: string, participantCount: number): string {
    const msg = userMessage.toLowerCase();
    const isMeeting = participantCount > 2;

    const contextReplies: Record<string, Record<string, string[]>> = {
      'minjun-ceo': {
        _default: ['데이터 기반으로 결정합시다.', '서연한테 수치 확인 부탁합니다.', '다음 단계 논의하죠.'],
        '분석|데이터|수치': ['서연, 관련 데이터 좀 공유해줘.', '수치로 봤을 때 어떤가요?'],
        '포스트|콘텐츠': ['빈이, 이번 포스트 주제 어떻게 잡을 거야?', '카테고리 비율 확인하고 배정하겠습니다.'],
        '전략|방향': ['현재 전략 기조를 유지하면서 세부 조정합시다.', '실험 데이터를 보고 판단하겠습니다.'],
        '회의|스탠드업': ['좋습니다. 각자 의견 공유해주세요.', '오늘 안건부터 정리하죠.'],
      },
      'seoyeon-analyst': {
        _default: ['데이터를 확인해볼게요.', '분석 결과를 공유해드릴게요.'],
        '분석|데이터|수치': ['최근 7일 데이터 보면 조회수 평균이 약간 올랐어요.', '카테고리별 참여율 비교해볼게요.'],
        '포스트|성과': ['이번 주 TOP 포스트는 뷰티 카테고리에서 나왔어요.', '성과 이상치 있는지 체크해볼게요.'],
        '전략|방향': ['데이터로 보면 현재 방향이 맞는 것 같아요.', 'ROI 기준으로 카테고리 비율 제안해볼게요.'],
      },
      'bini-beauty-editor': {
        _default: ['넹! 바로 확인할게요 ㅋㅋ', '오 좋은 아이디어에요~'],
        '포스트|콘텐츠|글': ['이번 주제 재밌을 것 같아요! 바로 초안 잡을게요~', '훅을 좀 더 강하게 가볼까요?'],
        '뷰티|화장품|피부': ['앗 이거 요즘 진짜 핫한 주제에요!', '모공이나 트러블 쪽이 반응 좋았어요~'],
        '수정|피드백': ['앗 그 부분 바로 수정할게요! ㅋㅋ', '오 맞아요 그게 더 자연스럽겠다!'],
      },
      'doyun-qa': {
        _default: ['QA 관점에서 확인해보겠습니다.', '체크리스트 기준으로 검토할게요.'],
        '포스트|콘텐츠': ['톤 검사부터 해볼게요. 전문 용어 들어가면 안 돼요.', '글자수랑 이모지 개수 체크할게요.'],
        '품질|검수': ['잠깐, 이건 좀 위험한데... 한번 더 확인해보죠.', '보수적으로 판단할게요. 확실하지 않으면 REJECT입니다.'],
      },
      'junho-researcher': {
        _default: ['이거 재밌는 거 찾았어요!', '트렌드 데이터 확인해볼게요.'],
        '트렌드|수집': ['X 트렌딩 확인해봤는데 관련 키워드가 떠요!', '벤치마크 채널에서 비슷한 주제 포스트 찾았어요.'],
        '브랜드|이벤트': ['브랜드 이벤트 리서치 바로 할게요!', '신제품 출시 소식 있는지 볼게요.'],
      },
      'taeho-engineer': {
        _default: ['기술적으로 확인해보겠습니다.', '시스템 상태 체크해볼게요.'],
        '에러|버그|문제': ['로그 확인해볼게요. 원인 파악하겠습니다.', '인프라 쪽 이슈인지 체크해볼게요.'],
        '시스템|서버': ['현재 시스템 정상 가동 중입니다.', 'DB 상태 양호합니다.'],
      },
      'jihyun-marketing-lead': {
        _default: ['다들 의견 모아볼까요~', '마케팅 관점에서 검토할게요.'],
        '전략|카테고리': ['카테고리 비율 조정이 필요할 수 있어요.', '에디터들 의견도 들어봐야 할 것 같아요.'],
      },
      'hana-health-editor': {
        _default: ['건강 카테고리로 확인해볼게요!', '관련 소재 찾아볼게요.'],
      },
      'sora-lifestyle-editor': {
        _default: ['생활 팁으로 풀어볼게요!', '네 바로 작업할게요~'],
      },
      'jiu-diet-editor': {
        _default: ['다이어트 관련 소재 확인할게요!', '바로 해볼게요!'],
      },
    };

    const agentReplies = contextReplies[agent.id] || { _default: ['네, 확인했습니다.'] };

    // Try to match keywords
    for (const [keywords, replies] of Object.entries(agentReplies)) {
      if (keywords === '_default') continue;
      const keywordList = keywords.split('|');
      if (keywordList.some(k => msg.includes(k))) {
        return replies[Math.floor(Math.random() * replies.length)];
      }
    }

    // Meeting context: add conversational style
    if (isMeeting) {
      const meetingPrefixes = ['', '저도 한마디 하면, ', '추가로, '];
      const prefix = meetingPrefixes[Math.floor(Math.random() * meetingPrefixes.length)];
      const defaultReplies = agentReplies._default || ['네, 확인했습니다.'];
      return prefix + defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
    }

    const defaultReplies = agentReplies._default || ['네, 확인했습니다.'];
    return defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
  }

  async function simulateAgentReply(roomId: string, participants: string[], userMessage: string) {
    const otherAgents = participants.filter(p => p !== 'sihun-owner');
    if (otherAgents.length === 0) return;

    // ALL agents reply with staggered delays (1-4 seconds apart)
    for (let i = 0; i < otherAgents.length; i++) {
      const agentId = otherAgents[i];
      const agent = BINILAB_AGENTS.find(a => a.id === agentId);
      if (!agent) continue;

      const delay = 1000 + (i * 1500) + Math.random() * 1000; // 1s, 2.5s, 4s, etc.

      setTimeout(async () => {
        const reply = generateContextualReply(agent, userMessage, otherAgents.length);

        await fetch('/api/chat/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_id: roomId,
            sender: agentId,
            message: reply,
            message_type: 'report',
          }),
        });

        // Refresh messages after each reply
        reloadMessages();
      }, delay);
    }
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
        simulateAgentReply(selectedRoom.id, participants, trimmed);
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
