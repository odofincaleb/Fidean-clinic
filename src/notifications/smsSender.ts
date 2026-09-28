// SMSLive247 REST API sender (Nigeria).
// Credentials come from environment variables:
//   SMSLIVE247_API_KEY — the master API key
//   SMSLIVE247_SENDER_ID — sender name (default "Fidean")
const SMSLIVE247_BASE = 'https://api.smslive247.com';

export interface SmsSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export async function sendSmsMessage(input: {
  to: string;
  body: string;
  senderId?: string;
}): Promise<SmsSendResult> {
  const apiKey = process.env.SMSLIVE247_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'SMSLIVE247_NOT_CONFIGURED' };
  }
  if (!input.to?.trim() || !input.body?.trim()) return { ok: false, error: 'INVALID_PAYLOAD' };

  const senderId = input.senderId || process.env.SMSLIVE247_SENDER_ID || 'Fidean';

  try {
    const url = `${SMSLIVE247_BASE}/api/v1/sms/send?apiKey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: input.to,
        message: input.body,
        sender: senderId,
      }),
    });
    const data = await response.json() as any;
    if (response.ok && data?.status === 'success') {
      return { ok: true, providerMessageId: String(data?.id || data?.reference || '') };
    }
    return { ok: false, error: data?.message || `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}