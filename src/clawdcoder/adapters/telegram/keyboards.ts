import { InlineKeyboard } from 'grammy';
import type { Session } from '../../types.js';

export function createSessionListKeyboard(sessions: Session[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const session of sessions) {
    const icon = session.status === 'active' ? '🟢' : '🔴';
    keyboard.text(`${icon} ${session.name}`, `select:${session.id}`).row();
  }

  return keyboard;
}

export function createSessionActionsKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📤 Output', `output:${sessionId}`)
    .text('🔌 Switch', `switch:${sessionId}`)
    .row()
    .text('🛑 Kill', `kill:${sessionId}`)
    .text('🔙 Back', 'session:list');
}

export function createConfirmKillKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm', `confirm-kill:${sessionId}`)
    .text('❌ Cancel', 'session:list');
}
