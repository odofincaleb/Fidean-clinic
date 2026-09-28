// SMSLive247 REST API v4 sender (Nigeria).
// Credentials come from environment variables:
//   SMSLIVE247_API_KEY — the master API key (used as Authorization header)
//   SMSLIVE247_SENDER_ID — sender name (default "Fidean")
const SMSLIVE247_BASE = 'https://api.smslive247.com/api/v4/sms';

export interface SmsSendResult {
  ok: boolean;
  providerMessageId?: string;
  /** Actual units/credits charged by smslive247 for this message */
  chargedUnits?: number;
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
  // Normalise phone number: remove leading zeros/+, prepend 234
  let phone = input.to.trim().replace(/[^0-9]/g, '');
  if (phone.startsWith('0')) phone = '234' + phone.slice(1);
  else if (phone.startsWith('234') && phone.length > 10) { /* ok */ }
  else if (!phone.startsWith('234')) phone = '234' + phone;
  // Ensure + prefix
  phone = '+' + phone;

  try {
    const response = await fetch(SMSLIVE247_BASE, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        senderID: senderId,
        mobileNumber: phone,
        messageText: input.body,
      }),
    });
    const data = await response.json() as any;
    if (response.ok && data?.batchID) {
      return {
        ok: true,
        providerMessageId: String(data.messageID || data.batchID || ''),
        chargedUnits: Number(data.charged) || undefined,
      };
    }
    return { ok: false, error: data?.message || `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}