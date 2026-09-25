export const OFFLINE_DB_NAME = 'fidean-clinic-offline-v1';
export const STORE_RECORDS = 'offlineRecords';
export const STORE_QUEUE = 'syncQueue';
export const STORE_META = 'syncMeta';
export const QUEUE_STATUSES = ['queued', 'syncing', 'synced', 'failed', 'conflict'];
export const RECORD_STATUSES = ['draft', 'queued', 'syncing', 'synced', 'failed', 'conflict'];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: 'localId' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'clientOperationId' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putRecord(record) {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  tx.objectStore(STORE_RECORDS).put(record);
  await txDone(tx);
}

export async function putQueueItem(item) {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, 'readwrite');
  tx.objectStore(STORE_QUEUE).put(item);
  await txDone(tx);
}

export async function getAllQueue() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readonly');
    const request = tx.objectStore(STORE_QUEUE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const request = tx.objectStore(STORE_RECORDS).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}

export async function getMeta(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const request = tx.objectStore(STORE_META).get(key);
    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error);
  });
}

export async function clearSynced() {
  const items = await getAllQueue();
  const records = await getAllRecords();
  const db = await openDb();
  const tx = db.transaction([STORE_QUEUE, STORE_RECORDS], 'readwrite');
  const queueStore = tx.objectStore(STORE_QUEUE);
  const recordStore = tx.objectStore(STORE_RECORDS);
  items.filter((item) => item.status === 'synced').forEach((item) => queueStore.delete(item.clientOperationId));
  records.filter((item) => item.status === 'synced').forEach((item) => recordStore.delete(item.localId));
  await txDone(tx);
}

export async function clearAllOfflineData() {
  const db = await openDb();
  const tx = db.transaction([STORE_QUEUE, STORE_RECORDS, STORE_META], 'readwrite');
  tx.objectStore(STORE_QUEUE).clear();
  tx.objectStore(STORE_RECORDS).clear();
  tx.objectStore(STORE_META).clear();
  await txDone(tx);
}

export async function pendingCount() {
  const items = await getAllQueue();
  return items.filter((item) => item.status === 'queued' || item.status === 'syncing' || item.status === 'failed' || item.status === 'conflict').length;
}

export async function unsyncedCount() {
  const items = await getAllQueue();
  return items.filter((item) => item.status !== 'synced').length;
}
