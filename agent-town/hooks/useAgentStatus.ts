'use client';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

interface AgentStatus {
  id: string;
  name: string;
  role: string;
  status: string;
  location: string;
  current_task: string | null;
  last_active_at: string | null;
}

export function useAgentStatus() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);

  const fetchAgents = useCallback(async () => {
    const res = await fetch('/api/agents/status');
    if (res.ok) {
      const data = await res.json();
      setAgents(data.agents ?? []);
    }
  }, []);

  useEffect(() => {
    fetchAgents();

    // Subscribe to realtime changes
    const channel = supabase
      .channel('agent-status-changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents' },
        (payload) => {
          setAgents(prev => prev.map(a =>
            a.id === (payload.new as AgentStatus).id
              ? { ...a, ...(payload.new as Partial<AgentStatus>) }
              : a
          ));
        }
      )
      .subscribe();

    // Poll every 30s as fallback
    const interval = setInterval(fetchAgents, 30_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [fetchAgents]);

  return agents;
}
