import nodemailer from 'nodemailer';
import type { NotificationJob, ClinicSettings } from '../domain/types.js';

export interface NotificationProviderResult {
  ok: boolean;
  provider: 'smtp' | 'dry_run';
  providerMessageId?: string;
  error?: string;
}

let transporterCache: Map<string, nodemailer.Transporter> = new Map();

function getTransporter(settings: ClinicSettings): nodemailer.Transporter | null {
  if (!settings.smtpHost) return null;
  const key = settings.tenantId;
  const cached = transporterCache.get(key);
  if (cached) return cached;
  const t = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort || 587,
    secure: settings.smtpPort === 465,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPass } : undefined,
    tls: { rejectUnauthorized: false },
  });
  transporterCache.set(key, t);
  return t;
}

export function clearTransporterCache(tenantId: string): void {
  transporterCache.delete(tenantId);
}

export async function sendNotification(
  job: NotificationJob,
  settings: ClinicSettings,
): Promise<NotificationProviderResult> {
  if (!job.recipient?.trim() || job.recipient.length < 3) {
    return { ok: false, provider: 'dry_run', error: 'INVALID_RECIPIENT' };
  }
  if (!job.body?.trim()) {
    return { ok: false, provider: 'dry_run', error: 'INVALID_BODY' };
  }
  if (job.channel !== 'email') {
    return { ok: false, provider: 'dry_run', error: 'Only email channel is supported' };
  }

  const transporter = getTransporter(settings);
  if (!transporter) {
    return { ok: false, provider: 'dry_run', error: 'SMTP not configured for this tenant. Configure SMTP in Settings.' };
  }

  try {
    const fromName = settings.smtpFromName || 'Clinic Portal';
    const fromAddr = settings.smtpFromEmail || settings.smtpUser || 'noreply@clinic.local';
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to: job.recipient,
      subject: job.subject || 'Clinic notification',
      html: (job.body || '').replace(/\n/g, '<br/>'),
    });
    return { ok: true, provider: 'smtp', providerMessageId: info.messageId };
  } catch (err) {
    return { ok: false, provider: 'smtp', error: String(err) };
  }
}

/** Legacy dry-run function kept for backward compatibility */
export async function sendNotificationDryRun(job: NotificationJob): Promise<NotificationProviderResult> {
  return sendNotification(job, { smtpHost: '' } as ClinicSettings);
}
