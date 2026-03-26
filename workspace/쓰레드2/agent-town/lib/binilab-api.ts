import { createAdminClient } from './supabase';

export async function getPerformanceSummary(period: '7d' | '30d' | 'today') {
  const db = createAdminClient();
  const days = period === 'today' ? 1 : period === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Fetch reports
  const { data: reports } = await db
    .from('daily_performance_reports')
    .select('*')
    .gte('report_date', since)
    .order('report_date', { ascending: false });

  // Fetch category breakdown from content_lifecycle + post_snapshots
  let categories = null;
  try {
    const { data } = await db.rpc('get_category_breakdown', { since_date: since });
    categories = data;
  } catch {
    categories = null;
  }

  // Fetch top posts
  const { data: topPosts } = await db
    .from('content_lifecycle')
    .select('id, threads_post_id, threads_post_url, content_text, need_category, hook_type, posted_at, maturity, current_impressions')
    .not('posted_at', 'is', null)
    .gte('posted_at', since)
    .order('current_impressions', { ascending: false })
    .limit(5);

  const latest = reports?.[0];
  const previous = reports?.[1];

  return {
    period,
    summary: {
      total_posts: latest?.total_posts ?? 0,
      total_views: latest?.total_views ?? 0,
      total_likes: latest?.total_likes ?? 0,
      total_comments: latest?.total_comments ?? 0,
      total_reposts: latest?.total_reposts ?? 0,
      avg_engagement_rate: latest?.avg_engagement_rate ?? 0,
      revenue: 0,
      warmup_progress: '19/20',
    },
    growth: {
      views_change_pct: latest && previous ? ((latest.total_views - previous.total_views) / (previous.total_views || 1)) * 100 : 0,
      likes_change_pct: latest && previous ? ((latest.total_likes - previous.total_likes) / (previous.total_likes || 1)) * 100 : 0,
      engagement_change_pct: latest && previous ? ((latest.avg_engagement_rate - previous.avg_engagement_rate) / (previous.avg_engagement_rate || 1)) * 100 : 0,
    },
    category_breakdown: categories ?? [],
    top_posts: (topPosts ?? []).map(p => ({
      post_id: p.threads_post_id,
      text_preview: p.content_text?.slice(0, 50) + '...',
      views: p.current_impressions,
      category: p.need_category,
      posted_at: p.posted_at,
    })),
  };
}

export async function getPosts(params: { status?: string; category?: string; sort?: string; limit?: number; offset?: number }) {
  const db = createAdminClient();
  let query = db
    .from('content_lifecycle')
    .select('*', { count: 'exact' });

  if (params.category) query = query.eq('need_category', params.category);
  if (params.status === 'published') query = query.not('posted_at', 'is', null);
  if (params.status === 'draft') query = query.is('posted_at', null);

  const sortCol = params.sort === 'views_desc' ? 'current_impressions' : params.sort === 'engagement_desc' ? 'current_impressions' : 'created_at';
  query = query.order(sortCol, { ascending: false });
  query = query.range(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 20) - 1);

  const { data, count } = await query;
  return {
    posts: (data ?? []).map(p => ({
      id: p.id,
      threads_post_id: p.threads_post_id,
      threads_post_url: p.threads_post_url,
      content_preview: p.content_text?.slice(0, 60),
      category: p.need_category,
      hook_type: p.hook_type,
      posted_at: p.posted_at,
      maturity: p.maturity,
      metrics: {
        views: p.current_impressions ?? 0,
        likes: 0,
        comments: 0,
        reposts: 0,
        engagement_rate: 0,
      },
    })),
    total: count ?? 0,
  };
}

export async function getTimeline() {
  const db = createAdminClient();
  const today = new Date().toISOString().split('T')[0];

  const { data: episodes } = await db
    .from('agent_episodes')
    .select('agent_id, event_type, summary, occurred_at')
    .gte('occurred_at', today + 'T00:00:00Z')
    .order('occurred_at', { ascending: true })
    .limit(50);

  const events = (episodes ?? []).map(ep => ({
    time: new Date(ep.occurred_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    type: ep.event_type,
    agent: ep.agent_id,
    summary: ep.summary,
  }));

  return { timeline: [{ date: today, events }] };
}

export async function getAlerts() {
  const db = createAdminClient();

  // 1. Pending approvals
  const { data: approvals } = await db
    .from('pending_approvals')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // 2. Strategy changes (recent)
  const { data: strategies } = await db
    .from('strategy_archive')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(3);

  const alerts = [
    ...(approvals ?? []).map(a => ({
      id: a.id,
      type: 'pending_approval' as const,
      priority: 'high' as const,
      title: a.description,
      description: `${a.requested_by}이(가) ${a.approval_type} 요청`,
      source_table: 'pending_approvals',
      source_id: a.id,
      created_at: a.created_at,
      actions: ['approve', 'reject'],
    })),
    ...(strategies ?? []).map(s => ({
      id: s.id,
      type: 'strategy_change' as const,
      priority: 'medium' as const,
      title: `전략 v${s.version}`,
      description: `전략 버전 ${s.version} (${s.status})`,
      source_table: 'strategy_archive',
      source_id: s.id,
      created_at: s.created_at,
      actions: ['acknowledge'],
    })),
  ];

  return {
    alerts,
    summary: {
      pending_approvals: approvals?.length ?? 0,
      strategy_changes: strategies?.length ?? 0,
      total: alerts.length,
    },
  };
}

export async function handleAlertAction(alertId: string, action: string, comment?: string) {
  const db = createAdminClient();
  if (action === 'approve' || action === 'reject') {
    await db
      .from('pending_approvals')
      .update({ status: action === 'approve' ? 'approved' : 'rejected', resolved_at: new Date().toISOString() })
      .eq('id', alertId);
  }
  return { success: true };
}

export async function getAgentStatuses() {
  const db = createAdminClient();
  const [{ data: agents }, { data: activeTasks }] = await Promise.all([
    db.from('agents').select('*').order('department', { ascending: true }),
    db.from('agent_tasks').select('assigned_to').eq('status', 'in_progress'),
  ]);

  const busyAgents = new Set((activeTasks ?? []).map(t => t.assigned_to));

  return {
    agents: (agents ?? []).map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      department: a.department,
      team: a.team,
      is_team_lead: a.is_team_lead,
      status: a.status ?? 'idle',
      location: a.location ?? 'desk',
      current_task: a.current_task ?? null,
      last_active_at: a.last_active_at ?? null,
      avatar_color: a.avatar_color,
      is_working: busyAgents.has(a.id),
    })),
    summary: {
      active: (agents ?? []).filter(a => a.status === 'active').length,
      idle: (agents ?? []).filter(a => a.status !== 'active').length,
    },
  };
}
