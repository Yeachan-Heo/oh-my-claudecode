import type { User } from '../types.js';
import { hasRole, getRequiredRole, type Role } from './roles.js';

export { hasRole, getRequiredRole, ROLE_HIERARCHY, COMMAND_PERMISSIONS } from './roles.js';
export type { Role };

export function checkPermission(user: User, command: string): boolean {
  const requiredRole = getRequiredRole(command);
  return hasRole(user.role, requiredRole);
}

export function requiresAdmin(user: User): boolean {
  return user.role === 'admin';
}

export function isOwnerOrAdmin(user: User, resourceOwnerId: string): boolean {
  return user.id === resourceOwnerId || user.role === 'admin';
}
