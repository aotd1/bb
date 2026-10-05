const DATABASE_NAME = "bb.pasted-text-drafts";
const STORE_NAME = "files";
const fallbackFiles = new Map<string, Blob>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Could not open pasted text recovery storage."));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () =>
        reject(new Error("Could not save pasted text for recovery."));
      transaction.onerror = () =>
        reject(new Error("Could not save pasted text for recovery."));
    });
  } finally {
    database.close();
  }
}

export async function savePastedTextFile(
  id: string,
  file: Blob,
): Promise<void> {
  fallbackFiles.set(id, file);
  await transact("readwrite", (store) => store.put(file, id));
}

export async function readPastedTextFile(id: string): Promise<Blob> {
  const fallback = fallbackFiles.get(id);
  if (fallback) return fallback;
  const file: unknown = await transact("readonly", (store) => store.get(id));
  if (!(file instanceof Blob)) {
    throw new Error("Pasted text recovery file is unavailable.");
  }
  return file;
}

export async function deletePastedTextFile(id: string): Promise<void> {
  fallbackFiles.delete(id);
  await transact("readwrite", (store) => store.delete(id));
}
