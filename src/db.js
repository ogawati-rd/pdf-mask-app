const DB_NAME = "pdf-memorize-pwa-db";
const DB_VERSION = 2;
const STORE_DOCS = "documents";
const STORE_BLOBS = "pdfBlobs";
const LEGACY_DB_NAMES = [
  "pdf-memorize-pwa-db-v31",
  "pdf-memorize-pwa-db-ver3"
];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const store = db.createObjectStore(STORE_DOCS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
      }

      // Migrate legacy v2.4 shape:
      // documents store used to embed pdfBlob directly in each document record.
      // Move those blobs into the dedicated store so existing study data stays visible.
      const docsStore = tx.objectStore(STORE_DOCS);
      const blobsStore = tx.objectStore(STORE_BLOBS);
      const cursorReq = docsStore.openCursor();

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;

        const doc = cursor.value;
        if (doc && doc.id && doc.pdfBlob) {
          blobsStore.put({ id: doc.id, pdfBlob: doc.pdfBlob });
          delete doc.pdfBlob;
          cursor.update(doc);
        }

        cursor.continue();
      };
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openNamedDB(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAllDocs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCS, "readonly");
    const req = tx.objectStore(STORE_DOCS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetDoc(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCS, "readonly");
    const req = tx.objectStore(STORE_DOCS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPutDoc(doc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCS, "readwrite");
    const req = tx.objectStore(STORE_DOCS).put(doc);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeleteDoc(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_DOCS).delete(id);
    tx.objectStore(STORE_BLOBS).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClearAllDocs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_DOCS).clear();
    tx.objectStore(STORE_BLOBS).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbPutPdfBlob(id, pdfBlob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, "readwrite");
    const req = tx.objectStore(STORE_BLOBS).put({ id, pdfBlob });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetPdfBlob(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, "readonly");
    const req = tx.objectStore(STORE_BLOBS).get(id);
    req.onsuccess = () => resolve(req.result?.pdfBlob || null);
    req.onerror = () => reject(req.error);
  });
}

export async function migrateLegacyDatabasesIfNeeded() {
  const currentDocs = await dbGetAllDocs();
  if (currentDocs.length > 0) return false;

  let migrated = false;

  for (const legacyName of LEGACY_DB_NAMES) {
    try {
      const legacyDb = await openNamedDB(legacyName);
      const hasDocs = legacyDb.objectStoreNames.contains(STORE_DOCS);
      if (!hasDocs) {
        legacyDb.close();
        continue;
      }

      const docs = await new Promise((resolve, reject) => {
        const tx = legacyDb.transaction(STORE_DOCS, "readonly");
        const req = tx.objectStore(STORE_DOCS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });

      let blobs = [];
      if (legacyDb.objectStoreNames.contains(STORE_BLOBS)) {
        blobs = await new Promise((resolve, reject) => {
          const tx = legacyDb.transaction(STORE_BLOBS, "readonly");
          const req = tx.objectStore(STORE_BLOBS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      }

      legacyDb.close();

      for (const doc of docs) {
        const nextDoc = { ...doc };
        delete nextDoc.pdfBlob;
        await dbPutDoc(nextDoc);
        if (doc.pdfBlob) {
          await dbPutPdfBlob(doc.id, doc.pdfBlob);
        }
      }

      for (const blobRecord of blobs) {
        if (blobRecord?.id && blobRecord?.pdfBlob) {
          await dbPutPdfBlob(blobRecord.id, blobRecord.pdfBlob);
        }
      }

      if (docs.length || blobs.length) {
        migrated = true;
      }
    } catch {
      // Ignore missing legacy databases.
    }
  }

  return migrated;
}
