import nodemailer from 'nodemailer';
import type { ClinicSettings } from '../domain/types.js';

let transporterCache: Map<string, nodemailer.Transporter> = new Map();

function getTransporter(settings: ClinicSettings): nodemailer.Transporter {
  const key = settings.tenantId;
  const cached = transporterCache.get(key);
  if (cached) return cached;

  const t = nodemailer.createTransport({
    host: settings.smtpHost || 'localhost',
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

export async function sendEmail(
  settings: ClinicSettings,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!settings.smtpHost) {
    return { ok: false, error: 'SMTP not configured' };
  }
  if (!to || !subject || !body) {
    return { ok: false, error: 'Missing recipient, subject, or body' };
  }
  try {
    const transporter = getTransporter(settings);
    const fromName = settings.smtpFromName || 'Clinic Portal';
    const fromAddr = settings.smtpFromEmail || settings.smtpUser || 'noreply@clinic.local';
    await transporter.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject,
      html: body.replace(/\n/g, '<br/>'),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
