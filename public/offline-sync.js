import {
  clearAllOfflineData,
  clearSynced,
  getAllQueue,
  getAllRecords,
  getMeta,
  pendingCount,
  putQueueItem,
  putRecord,
  setMeta,
  unsyncedCount,
} from './offline-db.js';

const ORDER = ['patient', 'appointment', 'encounter', 'prescription', 'invoice', 'patientDocument'];

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

export function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export async function queueCreate({ tenantId, entityType, payload, endpoint, method = 'POST' }) {
  const localId = `local-${uuid()}`;
  const clientOperationId = uuid();
  const createdAt = nowIso();
  const record = {
    localId,
    entityType,
    tenantId,
    payload,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
  };
  const item = {
    clientOperationId,
    tenantId,
    entityType,
    operation: 'create',
    localId,
    endpoint,
    method,
    payload,
    status: 'queued',
    attempts: 0,
    createdAt,
  };
  await putRecord(record);
  await putQueueItem(item);
  return { localId, clientOperationId };
}

function remapPayload(payload, records) {
  const next = { ...payload };
  const map = Object.fromEntries(records.filter((item) => item.serverId).map((item) => [item.localId, item.serverId]));
  for (const key of ['patientId', 'appointmentId', 'encounterId', 'branchId', 'doctorMemberId']) {
    if (typeof next[key] === 'string' && map[next[key]]) next[key] = map[next[key]];
  }
  return next;
}

export async function syncNow(getHeaders) {
  const records = await getAllRecords();
  const items = (await getAllQueue()).slice().sort((a, b) => ORDER.indexOf(a.entityType) - ORDER.indexOf(b.entityType) || a.createdAt.localeCompare(b.createdAt));
  const pending = items.filter((item) => item.status === 'queued' || item.status === 'failed');
  if (!pending.length) {
    await setMeta('lastSyncAt', nowIso());
    return { ok: true, results: [] };
  }
  for (const item of pending) {
    item.status = 'syncing';
    item.lastAttemptAt = nowIso();
    item.attempts += 1;
    await putQueueItem(item);
  }
  const operations = pending.map((item) => ({
    clientOperationId: item.clientOperationId,
    entityType: item.entityType,
    operation: item.operation,
    payload: remapPayload(item.payload, records),
    createdAt: item.createdAt,
  }));
  let body;
  try {
    const response = await fetch('/api/sync/operations', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ operations }),
    });
    body = await response.json();
    if (!response.ok) throw new Error(body.error || 'SYNC_FAILED');
  } catch (error) {
    for (const item of pending) {
      item.status = 'failed';
      item.error = error.message || 'SYNC_FAILED';
      await putQueueItem(item);
    }
    await setMeta('lastSyncAt', nowIso());
    throw error;
  }
  const byId = Object.fromEntries((body.results || []).map((item) => [item.clientOperationId, item]));
  for (const item of pending) {
    const result = byId[item.clientOperationId];
    if (!result) {
      item.status = 'failed';
      item.error = 'MISSING_RESULT';
    } else {
      item.status = result.status;
      item.serverId = result.serverId;
      item.error = result.error || result.message;
    }
    await putQueueItem(item);
    const record = records.find((row) => row.localId === item.localId);
    if (record) {
      record.status = item.status;
      record.serverId = item.serverId;
      record.error = item.error;
      record.updatedAt = nowIso();
      await putRecord(record);
    }
  }
  await setMeta('lastSyncAt', nowIso());
  return body;
}

export async function retryFailed(getHeaders) {
  const items = await getAllQueue();
  for (const item of items.filter((row) => row.status === 'failed' || row.status === 'conflict')) {
    item.status = 'queued';
    await putQueueItem(item);
  }
  return syncNow(getHeaders);
}

export async function renderOfflinePanel({ headers, onRefreshed } = {}) {
  const list = document.querySelector('#offline-queue-list');
  const banner = document.querySelector('#offline-banner');
  const statusEl = document.querySelector('#offline-connection');
  const pendingEl = document.querySelector('#offline-pending');
  const failedEl = document.querySelector('#offline-failed');
  const lastEl = document.querySelector('#offline-last-sync');
  if (!list) return;
  const items = await getAllQueue();
  const pending = items.filter((item) => item.status === 'queued' || item.status === 'syncing').length;
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'conflict').length;
  const last = await getMeta('lastSyncAt');
  if (statusEl) statusEl.textContent = isBrowserOffline() ? 'Offline' : 'Online';
  if (pendingEl) pendingEl.textContent = String(pending);
  if (failedEl) failedEl.textContent = String(failed);
  if (lastEl) lastEl.textContent = last ? new Date(last).toLocaleString() : 'Never';
  if (banner) banner.hidden = (await unsyncedCount()) === 0;
  list.innerHTML = items.map((item) =>
    `<article><h3>${item.entityType} ${item.operation}</h3><p>${item.status}${item.error ? ` · ${item.error}` : ''}</p><small>${item.createdAt}</small></article>`
  ).join('') || '<p>No queued operations.</p>';
  window.__offlineOnRefreshed = onRefreshed;
  window.__offlineHeaders = headers;
}

export function bindOfflineControls() {
  document.querySelector('#sync-now')?.addEventListener('click', async () => {
    if (window.__offlineHeaders) await syncNow(window.__offlineHeaders);
    if (window.__offlineOnRefreshed) await window.__offlineOnRefreshed();
    await renderOfflinePanel({ headers: window.__offlineHeaders, onRefreshed: window.__offlineOnRefreshed });
  });
  document.querySelector('#retry-failed')?.addEventListener('click', async () => {
    if (window.__offlineHeaders) await retryFailed(window.__offlineHeaders);
    if (window.__offlineOnRefreshed) await window.__offlineOnRefreshed();
    await renderOfflinePanel({ headers: window.__offlineHeaders, onRefreshed: window.__offlineOnRefreshed });
  });
  document.querySelector('#clear-synced')?.addEventListener('click', async () => {
    await clearSynced();
    await renderOfflinePanel({ headers: window.__offlineHeaders, onRefreshed: window.__offlineOnRefreshed });
  });
  document.querySelector('#clear-offline-data')?.addEventListener('click', async () => {
    if (!confirm('Clear all offline clinic data on this device? Unsynced records will be lost.')) return;
    await clearAllOfflineData();
    await renderOfflinePanel({ headers: window.__offlineHeaders, onRefreshed: window.__offlineOnRefreshed });
  });
}

export async function warnIfUnsyncedThenClear() {
  if ((await unsyncedCount()) > 0) {
    const proceed = confirm('This device has unsynced clinic data. Log out and clear local offline data?');
    if (!proceed) return false;
  }
  await clearAllOfflineData();
  return true;
}

export { clearAllOfflineData, pendingCount, unsyncedCount, getAllQueue };
