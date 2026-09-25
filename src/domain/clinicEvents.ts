import type { ClinicRepository } from '../repositories/ClinicRepository.js';
import type { NotificationJob, Patient } from './types.js';

export function patientRecipient(patient?: Patient): string {
  return patient?.email || patient?.phone || 'undeliverable@local';
}

export async function queuePatientNotification(
  repo: ClinicRepository,
  input: {
    tenantId: string;
    patientId?: string;
    memberId?: string;
    channel?: NotificationJob['channel'];
    type: NotificationJob['type'];
    subject?: string;
    body: string;
    recipient?: string;
  },
): Promise<NotificationJob> {
  let recipient = input.recipient;
  if (!recipient && input.patientId) {
    const patient = await repo.getPatient(input.patientId);
    recipient = patientRecipient(patient);
  }
  return repo.queueNotification({
    tenantId: input.tenantId,
    patientId: input.patientId,
    memberId: input.memberId,
    channel: input.channel ?? 'email',
    type: input.type,
    recipient: recipient || 'undeliverable@local',
    subject: input.subject,
    body: input.body,
  });
}

export async function audit(
  repo: ClinicRepository,
  input: {
    tenantId: string;
    actorUserId?: string;
    actorMemberId?: string;
    actorPatientAccountId?: string;
    actorType?: 'staff' | 'patient' | 'system';
    action: string;
    objectType?: string;
    objectId?: string;
    details?: unknown;
  },
): Promise<void> {
  await repo.recordAuditLog(input);
}

export function staffAudit(memberId: string) {
  return { actorType: 'staff' as const, actorMemberId: memberId };
}

export function patientAudit(patientAccountId: string) {
  return { actorType: 'patient' as const, actorPatientAccountId: patientAccountId };
}
