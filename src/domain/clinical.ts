import { httpError } from '../http/errors.js';
import type { Invoice, InvoiceLine } from './types.js';

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

export function assertScheduleWindow(startsAt: string, endsAt: string, slotMinutes: number): void {
  if (!timeRe.test(startsAt) || !timeRe.test(endsAt)) {
    throw httpError('INVALID_SCHEDULE_TIME', 400);
  }
  if (startsAt >= endsAt) {
    throw httpError('INVALID_SCHEDULE_RANGE', 400);
  }
  if (slotMinutes < 5) {
    throw httpError('INVALID_SLOT_MINUTES', 400);
  }
}

export function invoiceSubtotal(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceKobo, 0);
}

export function invoiceTotal(subtotalKobo: number, discountKobo: number, taxKobo: number): number {
  return subtotalKobo - discountKobo + taxKobo;
}

export function deriveInvoiceStatus(input: {
  voided?: boolean;
  issuedAt?: string;
  amountPaidKobo: number;
  totalKobo: number;
}): Invoice['status'] {
  if (input.voided) return 'void';
  if (!input.issuedAt) return 'draft';
  if (input.amountPaidKobo === input.totalKobo) return 'paid';
  if (input.amountPaidKobo > 0) return 'part_paid';
  return 'issued';
}

export function withInvoiceBalance<T extends Pick<Invoice, 'totalKobo' | 'amountPaidKobo' | 'hmoCoverageKobo' | 'status' | 'subtotalKobo' | 'discountKobo' | 'taxKobo'>>(
  invoice: T,
): T & { balanceKobo: number } {
  return { ...invoice, balanceKobo: Math.max(invoice.totalKobo - (invoice.hmoCoverageKobo || 0) - invoice.amountPaidKobo, 0) };
}

export function finalizeInvoiceFields(input: {
  lines: InvoiceLine[];
  discountKobo?: number;
  taxKobo?: number;
  amountPaidKobo?: number;
  issuedAt?: string;
  voided?: boolean;
}): Pick<Invoice, 'subtotalKobo' | 'discountKobo' | 'taxKobo' | 'totalKobo' | 'amountPaidKobo' | 'status' | 'balanceKobo'> {
  if (!input.lines.length) throw httpError('INVOICE_LINES_REQUIRED', 400);
  const discountKobo = input.discountKobo ?? 0;
  const taxKobo = input.taxKobo ?? 0;
  const amountPaidKobo = input.amountPaidKobo ?? 0;
  const subtotalKobo = invoiceSubtotal(input.lines);
  const totalKobo = invoiceTotal(subtotalKobo, discountKobo, taxKobo);
  return withInvoiceBalance({
    subtotalKobo,
    discountKobo,
    taxKobo,
    totalKobo,
    amountPaidKobo,
    status: deriveInvoiceStatus({ voided: input.voided, issuedAt: input.issuedAt, amountPaidKobo, totalKobo }),
  });
}

export function applyInvoicePayment(invoice: Invoice, amountKobo: number): Invoice {
  if (amountKobo <= 0) throw httpError('INVALID_PAYMENT_AMOUNT', 400);
  if (invoice.status === 'void') throw httpError('INVOICE_VOID', 409);
  if (invoice.status === 'draft' || !invoice.issuedAt) throw httpError('INVOICE_NOT_ISSUED', 409);
  const outstanding = Math.max(invoice.totalKobo - invoice.amountPaidKobo, 0);
  if (amountKobo > outstanding) throw httpError('PAYMENT_EXCEEDS_BALANCE', 409);
  const issuedAt = invoice.issuedAt;
  const totals = finalizeInvoiceFields({
    lines: invoice.lines,
    discountKobo: invoice.discountKobo,
    taxKobo: invoice.taxKobo,
    amountPaidKobo: invoice.amountPaidKobo + amountKobo,
    issuedAt,
  });
  return withInvoiceBalance({ ...invoice, issuedAt, ...totals });
}

export function toPublicPatientAccount(account: {
  id: string;
  tenantId: string;
  patientId: string;
  email: string;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  lastLoginAt?: string;
  activationTokenExpiresAt?: string;
  activationTokenUsedAt?: string;
}) {
  return {
    id: account.id,
    tenantId: account.tenantId,
    patientId: account.patientId,
    email: account.email,
    status: account.status,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    activationTokenExpiresAt: account.activationTokenExpiresAt,
    activationTokenUsedAt: account.activationTokenUsedAt,
  };
}
