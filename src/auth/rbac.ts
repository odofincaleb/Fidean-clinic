import type { Member, Permission, Role } from '../domain/types.js';

const matrix: Record<Role, Permission[]> = {
  owner: ['manage_subscription', 'manage_staff', 'manage_branches', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'manage_billing', 'view_reports', 'manage_inventory', 'send_staff_messages', 'manage_referrals'],
  admin: ['manage_staff', 'manage_branches', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'manage_billing', 'view_reports', 'manage_inventory', 'send_staff_messages', 'manage_referrals'],
  branch_manager: ['manage_staff', 'manage_branches', 'manage_appointments', 'create_appointment', 'view_patients', 'write_encounter', 'view_billing', 'view_reports', 'send_staff_messages', 'manage_referrals'],
  doctor: ['view_patients', 'write_encounter', 'create_appointment', 'view_billing', 'send_staff_messages', 'manage_referrals'],
  receptionist: ['create_appointment', 'view_patients'],
  nurse: ['view_patients', 'write_encounter', 'send_staff_messages'],
  accountant: ['view_billing', 'manage_billing', 'view_reports'],
  store_manager: ['manage_inventory', 'send_staff_messages'],
  viewer: ['view_patients', 'view_reports'],
};

export function canPerform(role: Role, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

export function assertCan(role: Role, permission: Permission): void {
  if (!canPerform(role, permission)) {
    const error = new Error(`Role ${role} cannot ${permission}`);
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}

export function canAccessBranch(member: Member, branchId: string): boolean {
  if (member.role === 'owner' || member.role === 'admin') return true;
  return member.branchIds.includes(branchId);
}

export function assertBranchAccess(member: Member, branchId: string): void {
  if (!canAccessBranch(member, branchId)) {
    const error = new Error('BRANCH_FORBIDDEN');
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}
