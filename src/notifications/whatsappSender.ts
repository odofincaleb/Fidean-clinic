// WhatsApp Cloud API sender.
// Uses the WhatsApp Business Cloud API with a platform-level access token
// (process.env.WHATSAPP_ACCESS_TOKEN). The phone number ID is fixed for this
// deployment. Per-tenant credentials are not supported by the Cloud API token
// model — the token lives server-side only and is never exposed to clients.
//
// Approved templates (must be created in WhatsApp Business Manager):
//   clinic_announcement_msg   → 1 body param: {{1}} = message text
//   clinic_appointment_reminder → 2 body params: {{1}} = patient name, {{2}} = appointment datetime
//   clinic_payment_receipt_msg  → 2 body params: {{1}} = patient name, {{2}} = amount
//   clinic_health_tip_msg       → 1 body param: {{1}} = tip text
const WHATSAPP_PHONE_NUMBER_ID = '1302276219632807';
const WHATSAPP_GRAPH_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

export interface WhatsAppSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export function getWhatsAppAccessToken(): string {
  return process.env.WHATSAPP_ACCESS_TOKEN || '';
}

export async function sendWhatsAppMessage(input: {
  to: string;
  body?: string;              // used for text messages; optional when template is used
  accessToken?: string;
  template?: {
    name: string;             // e.g. 'clinic_announcement_msg'
    language?: string;        // default 'en_US' (Meta templates are registered as en_US, not en)
    bodyParams?: string[];    // body component parameters
  };
}): Promise<WhatsAppSendResult> {
  const accessToken = input.accessToken || getWhatsAppAccessToken();
  if (!accessToken) return { ok: false, error: 'WHATSAPP_TOKEN_NOT_CONFIGURED' };
  if (!input.to?.trim()) return { ok: false, error: 'INVALID_PAYLOAD' };

  try {
    // Build the message payload
    let payload: Record<string, any> = {
      messaging_product: 'whatsapp',
      to: input.to,
    };

    if (input.template) {
      // Template message (approved in WhatsApp Business Manager)
      payload.type = 'template';
      const components: any[] = [];
      if (input.template.bodyParams && input.template.bodyParams.length > 0) {
        components.push({
          type: 'body',
          parameters: input.template.bodyParams.map((p) => ({ type: 'text', text: p })),
        });
      }
      payload.template = {
        name: input.template.name,
        language: { code: input.template.language || 'en_US' },
        components,
      };
    } else if (input.body?.trim()) {
      // Fallback: plain text message
      payload.type = 'text';
      payload.text = { body: input.body };
    } else {
      return { ok: false, error: 'INVALID_PAYLOAD' };
    }

    const response = await fetch(WHATSAPP_GRAPH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      return { ok: false, error: data?.error?.message || `WHATSAPP_HTTP_${response.status}` };
    }
    return { ok: true, providerMessageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}