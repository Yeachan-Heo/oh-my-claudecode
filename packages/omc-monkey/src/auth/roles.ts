export type Role = 'admin' | 'user' | 'viewer';

export const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 1,
  user: 2,
  admin: 3,
};

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export const COMMAND_PERMISSIONS: Record<string, Role> = {
  // Session commands
  'session.create': 'user',
  'session.list': 'viewer',
  'session.kill': 'user',
  'session.output': 'viewer',
  'prompt': 'user',

  // Admin commands
  'admin.users': 'admin',
  'admin.role': 'admin',
  'admin.cleanup': 'admin',

  // Read-only
  'status': 'viewer',
  'cost': 'viewer',
};

export function getRequiredRole(command: string): Role {
  return COMMAND_PERMISSIONS[command] ?? 'user';
}
