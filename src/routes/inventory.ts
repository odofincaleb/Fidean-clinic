import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

const money = z.preprocess((value) => (value === '' || value === null ? undefined : value), z.number().int().nonnegative().optional());
const optString = z.preprocess((value) => (value === '' || value === null ? undefined : value), z.string().optional());

export function registerInventoryRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/inventory', async (request) => {
    const auth = await requireAuth(request, repo);
    const [items, batches, movements, suppliers] = await Promise.all([
      repo.listInventoryItems(auth.tenantId),
      repo.listInventoryBatches(auth.tenantId),
      repo.listInventoryMovements(auth.tenantId),
      repo.listSuppliers(auth.tenantId),
    ]);
    return { ok: true, items, batches, movements, suppliers };
  });

  app.post('/api/inventory', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_inventory');
    const input = z.object({
      tenantId: z.string(),
      name: z.string().min(1),
      sku: optString,
      category: z.enum(['Drug', 'Consumable', 'Lab Item', 'Other']).or(z.string()).optional(),
      unit: optString,
      currentStock: z.number().int().nonnegative().optional(),
      reorderLevel: z.number().int().nonnegative().optional(),
      unitCostKobo: money,
      sellingPriceKobo: money,
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const item = await repo.createInventoryItem(input);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'inventory_create', objectType: 'inventory', objectId: item.id });
    return reply.code(201).send({ ok: true, item });
  });

  app.patch('/api/inventory/:id', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_inventory');
    const params = z.object({ id: z.string() }).parse(request.params);
    const items = await repo.listInventoryItems(auth.tenantId);
    const item = items.find((i) => i.id === params.id);
    if (!item) throw httpError('INVENTORY_ITEM_NOT_FOUND', 404);
    if (item.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const patch = z.object({
      name: z.string().min(1).optional(),
      sku: optString,
      category: z.enum(['Drug', 'Consumable', 'Lab Item', 'Other']).or(z.string()).optional(),
      unit: optString,
      reorderLevel: z.number().int().nonnegative().optional(),
      unitCostKobo: money,
      sellingPriceKobo: money,
      status: z.enum(['active', 'inactive']).optional(),
    }).parse(request.body);
    return { ok: true, item: await repo.updateInventoryItem(params.id, patch) };
  });

  app.get('/api/inventory/:id/movements', async (request) => {
    const auth = await requireAuth(request, repo);
    const params = z.object({ id: z.string() }).parse(request.params);
    const items = await repo.listInventoryItems(auth.tenantId);
    const item = items.find((i) => i.id === params.id);
    if (!item) throw httpError('INVENTORY_ITEM_NOT_FOUND', 404);
    if (item.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    return { ok: true, movements: await repo.listInventoryMovements(auth.tenantId, params.id), batches: await repo.listInventoryBatches(auth.tenantId, params.id) };
  });

  app.post('/api/inventory/:id/movement', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_inventory');
    const params = z.object({ id: z.string() }).parse(request.params);
    const items = await repo.listInventoryItems(auth.tenantId);
    const item = items.find((i) => i.id === params.id);
    if (!item) throw httpError('INVENTORY_ITEM_NOT_FOUND', 404);
    if (item.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const input = z.object({
      movementType: z.enum(['purchase', 'dispense', 'usage', 'adjustment', 'return', 'receive', 'adjust']),
      quantity: z.number().int(),
      batchId: optString,
      supplierId: optString,
      reference: optString,
      reason: optString,
      notes: optString,
      costPriceKobo: money,
      batchNumber: optString,
      expiryDate: optString,
      receivedAt: optString,
    }).parse(request.body);
    if (input.movementType !== 'adjustment' && input.movementType !== 'adjust' && input.quantity <= 0) {
      throw httpError('QUANTITY_MUST_BE_POSITIVE', 400);
    }
    const result = await repo.recordInventoryMovement(params.id, {
      tenantId: auth.tenantId,
      movementType: input.movementType,
      quantity: input.quantity,
      batchId: input.batchId,
      supplierId: input.supplierId,
      reference: input.reference,
      reason: input.reason,
      notes: input.notes,
      costPriceKobo: input.costPriceKobo,
      batchNumber: input.batchNumber,
      expiryDate: input.expiryDate,
      receivedAt: input.receivedAt,
      createdByMemberId: auth.member.id,
    });
    return reply.code(201).send({ ok: true, item: result.item, movement: result.movement });
  });

  app.post('/api/inventory/suppliers', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_inventory');
    const input = z.object({
      tenantId: z.string(),
      name: z.string().min(1),
      phone: optString,
      email: optString,
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const supplier = await repo.createSupplier(input);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'supplier_create', objectType: 'supplier', objectId: supplier.id });
    return reply.code(201).send({ ok: true, supplier });
  });
}
