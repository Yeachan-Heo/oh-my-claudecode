import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { room_id, message, sender } = await req.json();

    if (!room_id || !message || !sender) {
      return NextResponse.json(
        { error: 'room_id, message, sender required' },
        { status: 400 },
      );
    }

    const supabase = createAdminClient();

    // 1. 채팅방 참여자 조회
    const { data: participants } = await supabase
      .from('chat_participants')
      .select('agent_id')
      .eq('room_id', room_id);

    const participantIds = participants?.map((p: { agent_id: string }) => p.agent_id) ?? [];

    // 2. 채팅방 타입 조회
    const { data: room } = await supabase
      .from('chat_rooms')
      .select('type')
      .eq('id', room_id)
      .single();

    const roomType: string = room?.type ?? 'meeting';

    // 3. 의도 분류
    const mentionMatch = message.match(/@(\S+)/);
    let type: 'chat' | 'meeting' | 'task' = 'chat';
    let targets: string[] = [];

    if (mentionMatch) {
      type = 'task';
      const nameMap: Record<string, string> = {
        '민준': 'minjun-ceo',
        '서연': 'seoyeon-analyst',
        '빈이': 'bini-beauty-editor',
        '도윤': 'doyun-qa',
        '준호': 'junho-researcher',
        '태호': 'taeho-engineer',
        '지현': 'jihyun-marketing-lead',
        '하나': 'hana-health-editor',
        '소라': 'sora-lifestyle-editor',
        '지우': 'jiu-diet-editor',
      };
      const name: string = mentionMatch[1];
      const agentId =
        nameMap[name] ??
        participantIds.find((id: string) => id.includes(name.toLowerCase()));
      if (agentId) targets = [agentId];
    } else if (/회의|전체\s*의견|다들/.test(message)) {
      type = 'meeting';
      targets = participantIds.filter(
        (p: string) => p !== sender && p !== 'sihun-owner',
      );
    } else {
      type = 'chat';
      // CEO가 기본 응답자
      targets = participantIds.includes('minjun-ceo')
        ? ['minjun-ceo']
        : participantIds.slice(0, 1);
    }

    // 4. 각 대상 에이전트에 대해 pending_response 마커 생성
    for (const agentId of targets) {
      await supabase.from('agent_messages').insert({
        id: crypto.randomUUID(),
        sender: 'system',
        recipient: agentId,
        channel: 'dispatch',
        message: `[PENDING_RESPONSE] room=${room_id}`,
        message_type: 'task_assign',
        room_id: room_id,
        read_by: [],
        payload: { roomId: room_id, originalMessage: message, sender, roomType },
      });
    }

    return NextResponse.json({
      type,
      targets,
      status: 'dispatched',
      message: `${targets.length}명의 에이전트에게 전달됨`,
    });
  } catch (error) {
    console.error('Dispatch error:', error);
    return NextResponse.json({ error: 'dispatch failed' }, { status: 500 });
  }
}
