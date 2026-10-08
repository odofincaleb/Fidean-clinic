import type { Member, Permission, Role } from '../domain/types.js';
import { memberRoles, hasRole } from '../domain/types.js';

const matrix: Record<Role, Permission[]> = {
  owner: ['manage_subscription', 'manage_staff', 'manage_branches', 'manage_services', 'manage_broadcast', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'manage_billing', 'view_reports', 'manage_inventory', 'send_staff_messages', 'view_ledger', 'view_audit_logs', 'manage_referrals'],
  admin: ['manage_staff', 'manage_branches', 'manage_services', 'manage_broadcast', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'manage_billing', 'view_reports', 'manage_inventory', 'send_staff_messages', 'view_ledger', 'view_audit_logs', 'manage_referrals'],
  branch_manager: ['manage_staff', 'manage_branches', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'manage_billing', 'view_reports', 'manage_broadcast', 'send_staff_messages', 'view_ledger', 'view_audit_logs', 'manage_referrals'],
  doctor: ['view_patients', 'write_encounter', 'create_appointment', 'view_billing', 'send_staff_messages', 'manage_referrals'],
  receptionist: ['create_appointment', 'view_patients'],
  nurse: ['view_patients', 'write_encounter', 'send_staff_messages'],
  accountant: ['view_billing', 'manage_billing', 'view_reports', 'manage_services', 'view_ledger'],
  store_manager: ['manage_inventory', 'send_staff_messages', 'view_patients', 'view_reports'],
  viewer: ['view_patients', 'view_reports'],
};

export function canPerform(role: Role, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

function rolesOf(target: Role | Role[] | Member): Role[] {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target;
  return memberRoles(target);
}

/** True when the member has the permission via ANY of their roles. */
export function memberCan(m: Member, permission: Permission): boolean {
  return rolesOf(m).some((r) => canPerform(r, permission));
}

export function assertCan(target: Role | Role[] | Member, permission: Permission): void {
  const roles = rolesOf(target);
  if (!roles.some((role) => canPerform(role, permission))) {
    const message =
      typeof target === 'string' ? `Role ${target} cannot ${permission}` : `Insufficient roles for ${permission}`;
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
}

export function canAccessBranch(member: Member, branchId: string): boolean {
  if (hasRole(member, 'owner') || hasRole(member, 'admin')) return true;
  // An empty branch list means "all branches" (matches listVisibleBranches), so a
  // staff member with no explicit branch assignment can work in every branch.
  if (member.branchIds.length === 0) return true;
  return member.branchIds.includes(branchId);
}

export function assertBranchAccess(member: Member, branchId: string): void {
  if (!canAccessBranch(member, branchId)) {
    const error = new Error('BRANCH_FORBIDDEN');
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}
