import type { SaveEnvelope } from "@kayfabe/sim-core";

/**
 * IndexedDB save store (save-format@1). Deliberately dependency-free.
 * Desktop packaging will swap this behind the same interface for SQLite.
 */

const DB_NAME = "the-book";
const STORE = "saves";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "manifest.save_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function putSave(envelope: SaveEnvelope): Promise<IDBValidKey> {
  return tx("readwrite", (s) => s.put(envelope));
}

export function getSave(saveId: string): Promise<SaveEnvelope | undefined> {
  return tx("readonly", (s) => s.get(saveId) as IDBRequest<SaveEnvelope | undefined>);
}

export function listSaves(): Promise<SaveEnvelope["manifest"][]> {
  return tx("readonly", (s) => s.getAll() as IDBRequest<SaveEnvelope[]>).then((all) =>
    all
      .map((e) => e.manifest)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
  );
}

export function deleteSave(saveId: string): Promise<undefined> {
  return tx("readwrite", (s) => s.delete(saveId) as IDBRequest<undefined>);
}
