let database;
const keep = 14 * 24 * 60 * 60 * 1000;
export const attachmentBudget = 128 * 1024 * 1024;

function store(mode, work) {
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('tsukiakari-drafts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('attachments');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(Error('附件缓存暂不可用。'));
  });
  return database.then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('attachments', mode);
    const request = work(transaction.objectStore('attachments'));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  }));
}

export async function readFiles(key) {
  const value = await store('readonly', items => items.get(key));
  return value && Date.now() - value.saved < keep ? value.files : [];
}

export function storeFiles(key, files) {
  if (!files.length) return store('readwrite', items => items.delete(key));
  return store('readwrite', items => {
    const cursor = items.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) { if (item.key !== key && Date.now() - item.value.saved >= keep) item.delete(); item.continue(); }
    };
    return items.put({ saved: Date.now(), files: files.map(({ file, kind, uploaded }) => ({ file, kind, uploaded })) }, key);
  });
}
