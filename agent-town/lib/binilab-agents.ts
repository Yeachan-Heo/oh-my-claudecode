export interface BinilabAgent {
  id: string;
  name: string;
  role: string;
  department: 'executive' | 'marketing' | 'analysis' | 'qa' | 'engineering';
  team: string | null;
  isTeamLead: boolean;
  isResident: boolean; // 상주 vs 온디맨드
  avatarColor: string;
  category?: string; // 담당 카테고리 (에디터만)
}

export const BINILAB_AGENTS: BinilabAgent[] = [
  { id: 'minjun-ceo', name: '민준', role: 'CEO', department: 'executive', team: null, isTeamLead: false, isResident: true, avatarColor: '#FF6B6B' },
  { id: 'seoyeon-analyst', name: '서연', role: '분석팀장', department: 'analysis', team: '분석팀', isTeamLead: true, isResident: true, avatarColor: '#4ECDC4' },
  { id: 'bini-beauty-editor', name: '빈이', role: '뷰티 크리에이터', department: 'marketing', team: '마케팅팀', isTeamLead: false, isResident: true, avatarColor: '#FF69B4', category: '뷰티' },
  { id: 'doyun-qa', name: '도윤', role: '품질검수관', department: 'qa', team: null, isTeamLead: false, isResident: true, avatarColor: '#45B7D1' },
  { id: 'junho-researcher', name: '준호', role: '트렌드헌터', department: 'analysis', team: '분석팀', isTeamLead: false, isResident: true, avatarColor: '#96CEB4' },
  { id: 'taeho-engineer', name: '태호', role: '엔지니어', department: 'engineering', team: null, isTeamLead: false, isResident: true, avatarColor: '#FFEAA7' },
  { id: 'jihyun-marketing-lead', name: '지현', role: '마케팅팀장', department: 'marketing', team: '마케팅팀', isTeamLead: true, isResident: false, avatarColor: '#DDA0DD' },
  { id: 'hana-health-editor', name: '하나', role: '건강 에디터', department: 'marketing', team: '마케팅팀', isTeamLead: false, isResident: false, avatarColor: '#98FB98', category: '건강' },
  { id: 'sora-lifestyle-editor', name: '소라', role: '생활 에디터', department: 'marketing', team: '마케팅팀', isTeamLead: false, isResident: false, avatarColor: '#87CEEB', category: '생활' },
  { id: 'jiu-diet-editor', name: '지우', role: '다이어트 에디터', department: 'marketing', team: '마케팅팀', isTeamLead: false, isResident: false, avatarColor: '#F0E68C', category: '다이어트' },
  { id: 'sihun-owner', name: '시훈', role: '오너', department: 'executive', team: null, isTeamLead: false, isResident: true, avatarColor: '#FFD700' },
];

export function getAgent(id: string) {
  return BINILAB_AGENTS.find(a => a.id === id);
}

export function getResidentAgents() {
  return BINILAB_AGENTS.filter(a => a.isResident);
}
