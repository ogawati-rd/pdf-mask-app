export function makePdfId(fileLike) {
  return `pdf::${fileLike.name}::${fileLike.size}::${fileLike.lastModified}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("ja-JP");
  } catch {
    return iso || "-";
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function formatFileSizeMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function createEmptyDocState({ id, name, size, lastModified }) {
  return {
    id,
    name,
    size,
    lastModified,
    updatedAt: nowISO(),
    totalPages: 0,
    lastPage: 1,
    pages: {},
    favorite: false,
    schemaVersion: 31
  };
}

export function migrateDocShape(doc) {
  if (!doc) return null;
  if (!doc.pages) doc.pages = {};

  for (const key of Object.keys(doc.pages)) {
    const page = doc.pages[key] || {};
    if (!Array.isArray(page.masks)) page.masks = [];
    if (!Array.isArray(page.annotations)) page.annotations = [];

    for (const mask of page.masks) {
      if (mask.type === "line" && Array.isArray(mask.points) && mask.points.length >= 2) {
        const first = mask.points[0];
        const last = mask.points[mask.points.length - 1];
        mask.x1 = first.x;
        mask.y1 = first.y;
        mask.x2 = last.x;
        mask.y2 = last.y;
        delete mask.points;
      }
    }

    doc.pages[key] = page;
  }

  if (typeof doc.favorite !== "boolean") {
    doc.favorite = false;
  }

  delete doc.pdfBlob;
  doc.schemaVersion = 31;
  return doc;
}
