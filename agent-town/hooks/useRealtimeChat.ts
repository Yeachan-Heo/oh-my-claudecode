'use client';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

interface ChatMessage {
  id: string;
  sender: string;
  message: string;
  message_type: string;
  room_id: string;
  created_at: string;
  reply_to: string | null;
  mentions: string[];
}

export function useRealtimeChat(roomId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const fetchMessages = useCallback(async () => {
    if (!roomId) return;
    const res = await fetch(`/api/chat/rooms/${roomId}/messages?limit=50`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages ?? []);
    }
  }, [roomId]);

  useEffect(() => {
    fetchMessages();

    if (!roomId) return;

    const channel = supabase
      .channel(`chat-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessage;
          setMessages(prev => [...prev, newMsg]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, fetchMessages]);

  return { messages, refresh: fetchMessages };
}
