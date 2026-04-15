const APP_VERSION = "3.1";
const PDF_MODULE_URL = new URL("../pdf.mjs", import.meta.url);
const PDF_WORKER_URL = new URL("../pdf.worker.mjs", import.meta.url);

const pdfjsLib = await import(PDF_MODULE_URL.href);
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL.href;

const DB_NAME = "pdf-memorize-pwa-db-v31";
const DB_VERSION = 1;
const STORE_DOCS = "documents";
const STORE_BLOBS = "pdfBlobs";
const MAX_UNDO = 50;
const MIN_VISIBLE_CANVAS_WIDTH = 320;

const state = {
  pdfDoc: null,
  pdfBlob: null,
  pdfObjectUrl: null,
  pdfLoadingTask: null,
  currentPdfId: null,
  currentPdfName: "",
  currentPage: 1,
  totalPages: 0,
  mode: "study",
  createTool: "line",
  brushWidth: 18,
  brushColor: "rgba(12,18,28,0.96)",
  activeMarkType: null,
  drawing: false,
  drawingPage: null,
  activePointerId: null,
  startX: 0,
  startY: 0,
  currentDraft: null,
  docState: null,
  pageViews: new Map(),
  undoStack: [],
  pagesContainer: null,
  scrollRaf: null,
  resizeTimer: null,
  renderingVisiblePages: new Set(),
  pageObserver: null,
  docOpenToken: 0
};

const dom = {
  homeScreen: document.getElementById("homeScreen"),
  viewerScreen: document.getElementById("viewerScreen"),
  pdfFileInput: document.getElementById("pdfFileInput"),
  recentList: document.getElementById("recentList"),
  recentEmpty: document.getElementById("recentEmpty"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  checkUpdateBtn: document.getElementById("checkUpdateBtn"),
  backBtn: document.getElementById("backBtn"),
  docTitle: document.getElementById("docTitle"),
  pageInfo: document.getElementById("pageInfo"),
  modeLabel: document.getElementById("modeLabel"),
  toolLabel: document.getElementById("toolLabel"),
  renderLabel: document.getElementById("renderLabel"),
  pdfStageWrap: document.getElementById("pdfStageWrap"),
  viewerBody: document.getElementById("viewerBody"),
  createTools: document.getElementById("createTools"),
  studyTools: document.getElementById("studyTools"),
  createModeBtn: document.getElementById("createModeBtn"),
  studyModeBtn: document.getElementById("studyModeBtn"),
  drawLineBtn: document.getElementById("drawLineBtn"),
  drawRectBtn: document.getElementById("drawRectBtn"),
  eraserBtn: document.getElementById("eraserBtn"),
  undoBtn: document.getElementById("undoBtn"),
  showAllBtn: document.getElementById("showAllBtn"),
  hideAllBtn: document.getElementById("hideAllBtn"),
  brushSizeInput: document.getElementById("brushSizeInput"),
  brushSizeValue: document.getElementById("brushSizeValue"),
  colorChips: document.getElementById("colorChips"),
  markTypeChips: document.getElementById("markTypeChips")
};

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const store = db.createObjectStore(STORE_DOCS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, handler) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = handler(store, tx);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllDocs() {
  return withStore(STORE_DOCS, "readonly", (store) => readRequest(store.getAll()));
}

async function dbGetDoc(id) {
  return withStore(STORE_DOCS, "readonly", (store) => readRequest(store.get(id)));
}

async function dbPutDoc(doc) {
  return withStore(STORE_DOCS, "readwrite", (store) => readRequest(store.put(doc)));
}

async function dbDeleteDoc(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_DOCS).delete(id);
    tx.objectStore(STORE_BLOBS).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dbClearAllDocs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_DOCS).clear();
    tx.objectStore(STORE_BLOBS).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dbPutPdfBlob(id, pdfBlob) {
  return withStore(STORE_BLOBS, "readwrite", (store) => readRequest(store.put({ id, pdfBlob })));
}

async function dbGetPdfBlob(id) {
  const record = await withStore(STORE_BLOBS, "readonly", (store) => readRequest(store.get(id)));
  return record?.pdfBlob ?? null;
}

function makePdfId(fileLike) {
  return `pdf::${fileLike.name}::${fileLike.size}::${fileLike.lastModified}`;
}

function nowISO() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("ja-JP");
  } catch {
    return iso || "-";
  }
}

function formatFileSizeMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function makeDocMeta({ id, file }) {
  return {
    id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    updatedAt: nowISO(),
    totalPages: 0,
    lastPage: 1,
    pages: {},
    favorite: false,
    schemaVersion: 3
  };
}

function migrateDocShape(doc) {
  const next = doc ? { ...doc } : null;
  if (!next) return null;
  if (!next.pages) next.pages = {};

  for (const key of Object.keys(next.pages)) {
    const page = next.pages[key] || {};
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
      if (typeof mask.userHidden !== "boolean") {
        mask.userHidden = false;
      }
    }

    next.pages[key] = page;
  }

  next.schemaVersion = 3;
  return next;
}

function getPageState(pageNum) {
  if (!state.docState) return null;
  const key = String(pageNum);

  if (!state.docState.pages[key]) {
    state.docState.pages[key] = { masks: [], annotations: [] };
  }

  const page = state.docState.pages[key];
  if (!Array.isArray(page.masks)) page.masks = [];
  if (!Array.isArray(page.annotations)) page.annotations = [];
  return page;
}

function getCanvasMetrics(overlayCanvas) {
  const rect = overlayCanvas.getBoundingClientRect();
  return {
    rect,
    cssWidth: rect.width,
    cssHeight: rect.height,
    scaleX: rect.width ? overlayCanvas.width / rect.width : 1,
    scaleY: rect.height ? overlayCanvas.height / rect.height : 1
  };
}

function getPointerPos(event, overlayCanvas) {
  const { rect, cssWidth, cssHeight } = getCanvasMetrics(overlayCanvas);
  return {
    x: clamp(event.clientX - rect.left, 0, cssWidth),
    y: clamp(event.clientY - rect.top, 0, cssHeight)
  };
}

function toRatioPoint(px, py, overlayCanvas) {
  const { cssWidth, cssHeight } = getCanvasMetrics(overlayCanvas);
  return {
    x: cssWidth ? px / cssWidth : 0,
    y: cssHeight ? py / cssHeight : 0
  };
}

function fromRatioPoint(rx, ry, overlayCanvas) {
  const { cssWidth, cssHeight } = getCanvasMetrics(overlayCanvas);
  return {
    x: rx * cssWidth,
    y: ry * cssHeight
  };
}

function getMarkSymbol(type) {
  switch (type) {
    case "star":
      return "★";
    case "review":
      return "!";
    case "question":
      return "?";
    case "done":
      return "○";
    default:
      return "•";
  }
}

function getPageView(pageNum) {
  return state.pageViews.get(pageNum) || null;
}

function setTouchMode(disableScroll) {
  dom.viewerBody.classList.toggle("no-scroll", disableScroll);
}

function showHome() {
  dom.viewerScreen.classList.remove("active");
  dom.homeScreen.classList.add("active");
}

function showViewer() {
  dom.homeScreen.classList.remove("active");
  dom.viewerScreen.classList.add("active");
}

function updateBrushUI() {
  dom.brushSizeValue.textContent = String(state.brushWidth);
  dom.colorChips.querySelectorAll(".color-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.color === state.brushColor);
  });
}

function updateMarkUI() {
  dom.markTypeChips.querySelectorAll(".mark-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.mark === state.activeMarkType);
  });
}

function updateHeader() {
  dom.docTitle.textContent = state.currentPdfName || "-";
  dom.pageInfo.textContent = `${state.currentPage} / ${state.totalPages || 0}`;
  dom.modeLabel.textContent = state.mode === "create" ? "作成" : "学習";

  if (state.mode === "create") {
    const labels = {
      line: "直線",
      rect: "四角",
      eraser: "消しゴム"
    };
    dom.toolLabel.textContent = labels[state.createTool] || "待機中";
  } else {
    const labels = {
      star: "印: 重要",
      review: "印: 要復習",
      question: "印: わからない",
      done: "印: 覚えた",
      erase: "印: 消す"
    };
    dom.toolLabel.textContent = state.activeMarkType ? labels[state.activeMarkType] : "タップで表示切替";
  }

  const renderedCount = Array.from(state.pageViews.values()).filter((pageView) => pageView.rendered).length;
  dom.renderLabel.textContent = `描画 ${renderedCount}/${state.totalPages || 0}`;
}

function updateToolUI() {
  dom.drawLineBtn.classList.toggle("active", state.mode === "create" && state.createTool === "line");
  dom.drawRectBtn.classList.toggle("active", state.mode === "create" && state.createTool === "rect");
  dom.eraserBtn.classList.toggle("active", state.mode === "create" && state.createTool === "eraser");

  dom.createTools.classList.toggle("is-hidden", state.mode !== "create");
  dom.studyTools.classList.toggle("is-hidden", state.mode !== "study");
  dom.createModeBtn.classList.toggle("active", state.mode === "create");
  dom.studyModeBtn.classList.toggle("active", state.mode === "study");

  updateBrushUI();
  updateMarkUI();
  updateHeader();
}

function setMode(mode) {
  state.mode = mode;
  state.currentDraft = null;
  state.drawing = false;
  state.drawingPage = null;
  if (mode === "create") {
    state.activeMarkType = null;
  }
  redrawAllOverlays();
  updateToolUI();
}

function setCreateTool(tool) {
  state.createTool = tool;
  state.currentDraft = null;
  state.drawing = false;
  state.drawingPage = null;
  redrawAllOverlays();
  updateToolUI();
}

function pushUndoSnapshot(pageNum) {
  const pageState = getPageState(pageNum);
  if (!pageState) return;
  state.undoStack.push({
    pageNum,
    pageState: deepClone(pageState)
  });
  if (state.undoStack.length > MAX_UNDO) {
    state.undoStack.shift();
  }
}

async function undoLastAction() {
  const last = state.undoStack.pop();
  if (!last || !state.docState) return;
  state.docState.pages[String(last.pageNum)] = deepClone(last.pageState);
  redrawPageDecorations(last.pageNum);
  await persistDocState();
}

function downloadMeta(doc) {
  const pagesCount = doc.totalPages || 0;
  return `${formatDate(doc.updatedAt)} ・ ${formatFileSizeMB(doc.size)} ・ ${pagesCount}ページ`;
}

async function renderRecentList() {
  const docs = (await dbGetAllDocs()).map(migrateDocShape).filter(Boolean);
  docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  dom.recentList.innerHTML = "";
  dom.recentEmpty.style.display = docs.length ? "none" : "block";

  for (const doc of docs) {
    const item = document.createElement("div");
    item.className = "recent-item";

    const title = document.createElement("div");
    title.className = "recent-title";
    title.textContent = doc.name;

    const meta = document.createElement("div");
    meta.className = "recent-meta";
    meta.textContent = downloadMeta(doc);

    const actions = document.createElement("div");
    actions.className = "recent-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "recent-open-btn";
    openButton.textContent = "開く";
    openButton.addEventListener("click", () => openSavedPdf(doc.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "recent-delete-btn";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", async () => {
      const ok = confirm(`「${doc.name}」を履歴から削除しますか？`);
      if (!ok) return;
      await dbDeleteDoc(doc.id);
      if (state.currentPdfId === doc.id) {
        await closeCurrentDocument();
        showHome();
      }
      await renderRecentList();
    });

    actions.append(openButton, deleteButton);
    item.append(title, meta, actions);
    dom.recentList.appendChild(item);
  }
}

function cleanupObjectURL() {
  if (state.pdfObjectUrl) {
    URL.revokeObjectURL(state.pdfObjectUrl);
    state.pdfObjectUrl = null;
  }
}

function disconnectPageObserver() {
  if (state.pageObserver) {
    state.pageObserver.disconnect();
    state.pageObserver = null;
  }
}

function clearPageViews() {
  disconnectPageObserver();
  state.pageViews.clear();
  state.pagesContainer = null;
  state.renderingVisiblePages.clear();
  dom.pdfStageWrap.innerHTML = "";
}

async function closeCurrentDocument() {
  disconnectPageObserver();
  clearPageViews();
  cleanupObjectURL();

  if (state.pdfLoadingTask) {
    try {
      await state.pdfLoadingTask.destroy();
    } catch {
      // ignore destroy errors
    }
    state.pdfLoadingTask = null;
  }

  if (state.pdfDoc) {
    try {
      await state.pdfDoc.destroy();
    } catch {
      // ignore destroy errors
    }
  }

  state.pdfDoc = null;
  state.pdfBlob = null;
  state.currentPdfId = null;
  state.currentPdfName = "";
  state.currentPage = 1;
  state.totalPages = 0;
  state.docState = null;
  state.undoStack = [];
  updateHeader();
}

async function persistDocState() {
  if (!state.docState) return;
  state.docState.updatedAt = nowISO();
  state.docState.lastPage = state.currentPage;
  state.docState.totalPages = state.totalPages;
  await dbPutDoc(state.docState);
}

async function handleFileSelect(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    alert("PDFファイルを選択してください。");
    return;
  }

  const id = makePdfId(file);
  let docMeta = migrateDocShape(await dbGetDoc(id));

  if (!docMeta) {
    docMeta = makeDocMeta({ id, file });
  } else {
    docMeta.name = file.name;
    docMeta.size = file.size;
    docMeta.lastModified = file.lastModified;
    docMeta.updatedAt = nowISO();
  }

  await dbPutDoc(docMeta);
  await dbPutPdfBlob(id, file);
  await openDocumentRecord(docMeta, file);
  await renderRecentList();
}

async function openSavedPdf(id) {
  const docMeta = migrateDocShape(await dbGetDoc(id));
  const pdfBlob = await dbGetPdfBlob(id);
  if (!docMeta || !pdfBlob) {
    alert("保存されたPDFが見つかりませんでした。");
    if (docMeta && !pdfBlob) {
      await dbDeleteDoc(id);
      await renderRecentList();
    }
    return;
  }
  await openDocumentRecord(docMeta, pdfBlob);
}

function createPagesContainer() {
  const container = document.createElement("div");
  container.className = "pdf-pages-stack";
  return container;
}

function createPageStage(pageNum, ratioPercent) {
  const stage = document.createElement("div");
  stage.className = "pdf-stage pdf-page-stage placeholder";
  stage.dataset.page = String(pageNum);
  stage.style.setProperty("--page-ratio", `${ratioPercent}%`);

  const pdfCanvas = document.createElement("canvas");
  pdfCanvas.className = "pdf-page-canvas";

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.className = "overlay-page-canvas";

  const annotationLayer = document.createElement("div");
  annotationLayer.className = "annotation-layer";

  stage.append(pdfCanvas, overlayCanvas, annotationLayer);

  const pageView = {
    pageNum,
    stage,
    pdfCanvas,
    overlayCanvas,
    annotationLayer,
    pdfCtx: pdfCanvas.getContext("2d", { alpha: false }),
    overlayCtx: overlayCanvas.getContext("2d"),
    rendered: false,
    rendering: false
  };

  overlayCanvas.addEventListener("pointerdown", (event) => onPointerDown(event, pageNum), { passive: false });
  overlayCanvas.addEventListener("pointermove", (event) => onPointerMove(event, pageNum), { passive: false });
  overlayCanvas.addEventListener("pointerup", (event) => onPointerUp(event, pageNum), { passive: false });
  overlayCanvas.addEventListener("pointercancel", () => onPointerCancel(), { passive: false });

  return pageView;
}

async function buildPageSkeletons(openToken) {
  clearPageViews();
  state.pagesContainer = createPagesContainer();
  dom.pdfStageWrap.appendChild(state.pagesContainer);

  for (let pageNum = 1; pageNum <= state.totalPages; pageNum += 1) {
    if (openToken !== state.docOpenToken) return;

    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const ratioPercent = (viewport.height / viewport.width) * 100;
    const pageView = createPageStage(pageNum, ratioPercent);
    state.pageViews.set(pageNum, pageView);
    state.pagesContainer.appendChild(pageView.stage);
  }
}

function setupIntersectionObserver() {
  disconnectPageObserver();

  state.pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const pageNum = Number(entry.target.dataset.page);
        if (pageNum) {
          ensurePageRendered(pageNum);
        }
      });
    },
    {
      root: dom.viewerBody,
      rootMargin: "900px 0px"
    }
  );

  state.pageViews.forEach((pageView) => {
    state.pageObserver.observe(pageView.stage);
  });
}

async function ensurePageRendered(pageNum) {
  const pageView = getPageView(pageNum);
  if (!pageView || pageView.rendered || pageView.rendering || !state.pdfDoc) return;

  pageView.rendering = true;
  state.renderingVisiblePages.add(pageNum);
  updateHeader();

  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const unscaled = page.getViewport({ scale: 1 });
    const containerWidth = Math.max(MIN_VISIBLE_CANVAS_WIDTH, dom.pdfStageWrap.clientWidth - 24);
    const scale = containerWidth / unscaled.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssViewport = page.getViewport({ scale });
    const renderViewport = page.getViewport({ scale: scale * dpr });

    pageView.stage.classList.remove("placeholder");
    pageView.stage.style.width = `${cssViewport.width}px`;
    pageView.stage.style.height = `${cssViewport.height}px`;

    pageView.pdfCanvas.width = Math.floor(renderViewport.width);
    pageView.pdfCanvas.height = Math.floor(renderViewport.height);
    pageView.pdfCanvas.style.width = `${cssViewport.width}px`;
    pageView.pdfCanvas.style.height = `${cssViewport.height}px`;

    pageView.overlayCanvas.width = Math.floor(renderViewport.width);
    pageView.overlayCanvas.height = Math.floor(renderViewport.height);
    pageView.overlayCanvas.style.width = `${cssViewport.width}px`;
    pageView.overlayCanvas.style.height = `${cssViewport.height}px`;

    pageView.annotationLayer.style.width = `${cssViewport.width}px`;
    pageView.annotationLayer.style.height = `${cssViewport.height}px`;

    pageView.pdfCtx.setTransform(1, 0, 0, 1, 0, 0);
    pageView.pdfCtx.clearRect(0, 0, pageView.pdfCanvas.width, pageView.pdfCanvas.height);

    await page.render({
      canvasContext: pageView.pdfCtx,
      viewport: renderViewport
    }).promise;

    pageView.rendered = true;
    redrawPageDecorations(pageNum);
  } finally {
    pageView.rendering = false;
    state.renderingVisiblePages.delete(pageNum);
    updateHeader();
  }
}

function isMaskVisible(mask) {
  return !mask.userHidden;
}

function drawMask(ctx, overlayCanvas, mask, isDraft = false) {
  const color = mask.color || "rgba(12,18,28,0.96)";
  const metrics = getCanvasMetrics(overlayCanvas);

  ctx.save();
  ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0);
  ctx.fillStyle = color;
  ctx.globalAlpha = isDraft ? 0.88 : 1;

  if (mask.type === "rect") {
    const point = fromRatioPoint(mask.x, mask.y, overlayCanvas);
    const size = fromRatioPoint(mask.w, mask.h, overlayCanvas);
    ctx.fillRect(point.x, point.y, size.x, size.y);
  }

  if (mask.type === "line") {
    if (
      typeof mask.x1 !== "number" ||
      typeof mask.y1 !== "number" ||
      typeof mask.x2 !== "number" ||
      typeof mask.y2 !== "number"
    ) {
      ctx.restore();
      return;
    }

    const a = fromRatioPoint(mask.x1, mask.y1, overlayCanvas);
    const b = fromRatioPoint(mask.x2, mask.y2, overlayCanvas);
    const widthPx = Math.max(4, (mask.widthRatio || 0.02) * metrics.cssWidth);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);

    if (length < 1) {
      ctx.restore();
      return;
    }

    const nx = -dy / length;
    const ny = dx / length;
    const half = widthPx / 2;

    ctx.beginPath();
    ctx.moveTo(a.x + nx * half, a.y + ny * half);
    ctx.lineTo(b.x + nx * half, b.y + ny * half);
    ctx.lineTo(b.x - nx * half, b.y - ny * half);
    ctx.lineTo(a.x - nx * half, a.y - ny * half);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function redrawOverlayForPage(pageNum) {
  const pageView = getPageView(pageNum);
  const pageState = getPageState(pageNum);
  if (!pageView || !pageState || !pageView.overlayCanvas.width) return;

  const ctx = pageView.overlayCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pageView.overlayCanvas.width, pageView.overlayCanvas.height);

  for (const mask of pageState.masks) {
    if (!isMaskVisible(mask)) continue;
    drawMask(ctx, pageView.overlayCanvas, mask, false);
  }

  if (state.currentDraft && state.drawingPage === pageNum) {
    drawMask(ctx, pageView.overlayCanvas, state.currentDraft, true);
  }
}

function redrawAnnotationsForPage(pageNum) {
  const pageView = getPageView(pageNum);
  const pageState = getPageState(pageNum);
  if (!pageView || !pageState || !pageView.overlayCanvas.width) return;

  pageView.annotationLayer.innerHTML = "";

  for (const ann of pageState.annotations) {
    if (ann.type !== "mark") continue;

    const point = fromRatioPoint(ann.x, ann.y, pageView.overlayCanvas);
    const element = document.createElement("div");
    element.className = `annotation-mark mark-${ann.kind}`;
    element.style.left = `${point.x}px`;
    element.style.top = `${point.y}px`;
    element.textContent = getMarkSymbol(ann.kind);
    pageView.annotationLayer.appendChild(element);
  }
}

function redrawPageDecorations(pageNum) {
  redrawOverlayForPage(pageNum);
  redrawAnnotationsForPage(pageNum);
}

function redrawAllOverlays() {
  for (let pageNum = 1; pageNum <= state.totalPages; pageNum += 1) {
    redrawPageDecorations(pageNum);
  }
}

function hitTestRect(mask, px, py, overlayCanvas) {
  const point = fromRatioPoint(mask.x, mask.y, overlayCanvas);
  const size = fromRatioPoint(mask.w, mask.h, overlayCanvas);
  return px >= point.x && px <= point.x + size.x && py >= point.y && py <= point.y + size.y;
}

function distancePointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);

  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function hitTestLine(mask, px, py, overlayCanvas) {
  const metrics = getCanvasMetrics(overlayCanvas);
  if (
    typeof mask.x1 !== "number" ||
    typeof mask.y1 !== "number" ||
    typeof mask.x2 !== "number" ||
    typeof mask.y2 !== "number"
  ) {
    return false;
  }

  const a = fromRatioPoint(mask.x1, mask.y1, overlayCanvas);
  const b = fromRatioPoint(mask.x2, mask.y2, overlayCanvas);
  const widthPx = Math.max(8, (mask.widthRatio || 0.02) * metrics.cssWidth);
  const threshold = widthPx * 0.7 + 8;
  return distancePointToSegment(px, py, a.x, a.y, b.x, b.y) <= threshold;
}

function findTopMaskAt(pageNum, px, py) {
  const pageState = getPageState(pageNum);
  const pageView = getPageView(pageNum);
  if (!pageState || !pageView || !pageView.overlayCanvas.width) return null;

  for (let index = pageState.masks.length - 1; index >= 0; index -= 1) {
    const mask = pageState.masks[index];
    const hit = mask.type === "rect"
      ? hitTestRect(mask, px, py, pageView.overlayCanvas)
      : hitTestLine(mask, px, py, pageView.overlayCanvas);
    if (hit) return { mask, index };
  }

  return null;
}

function findAnnotationAt(pageNum, px, py) {
  const pageState = getPageState(pageNum);
  const pageView = getPageView(pageNum);
  if (!pageState || !pageView || !pageView.overlayCanvas.width) return null;

  for (let index = pageState.annotations.length - 1; index >= 0; index -= 1) {
    const ann = pageState.annotations[index];
    if (ann.type !== "mark") continue;

    const point = fromRatioPoint(ann.x, ann.y, pageView.overlayCanvas);
    if (Math.hypot(px - point.x, py - point.y) <= 22) {
      return { ann, index };
    }
  }

  return null;
}

function createLineDraft(startX, startY, overlayCanvas) {
  const point = toRatioPoint(startX, startY, overlayCanvas);
  const metrics = getCanvasMetrics(overlayCanvas);

  return {
    id: generateId("mask"),
    type: "line",
    widthRatio: state.brushWidth / Math.max(metrics.cssWidth, 1),
    color: state.brushColor,
    userHidden: false,
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y
  };
}

function createRectDraft(startX, startY, overlayCanvas) {
  const point = toRatioPoint(startX, startY, overlayCanvas);
  return {
    id: generateId("mask"),
    type: "rect",
    x: point.x,
    y: point.y,
    w: 0,
    h: 0,
    color: state.brushColor,
    userHidden: false
  };
}

function normalizeRectDraft(rect) {
  if (rect.w < 0) {
    rect.x += rect.w;
    rect.w = Math.abs(rect.w);
  }
  if (rect.h < 0) {
    rect.y += rect.h;
    rect.h = Math.abs(rect.h);
  }

  rect.x = clamp(rect.x, 0, 1);
  rect.y = clamp(rect.y, 0, 1);
  rect.w = clamp(rect.w, 0, 1);
  rect.h = clamp(rect.h, 0, 1);
}

async function finalizeDraft(pageNum) {
  const pageState = getPageState(pageNum);
  if (!pageState || !state.currentDraft) return;

  const draft = state.currentDraft;

  if (draft.type === "line") {
    const dx = Math.abs((draft.x2 ?? 0) - (draft.x1 ?? 0));
    const dy = Math.abs((draft.y2 ?? 0) - (draft.y1 ?? 0));
    if (dx + dy < 0.002) {
      state.currentDraft = null;
      redrawOverlayForPage(pageNum);
      return;
    }
  }

  if (draft.type === "rect") {
    if (Math.abs(draft.w) < 0.002 || Math.abs(draft.h) < 0.002) {
      state.currentDraft = null;
      redrawOverlayForPage(pageNum);
      return;
    }
    normalizeRectDraft(draft);
  }

  pushUndoSnapshot(pageNum);
  pageState.masks.push(draft);
  state.currentDraft = null;
  state.drawingPage = null;
  redrawOverlayForPage(pageNum);
  await persistDocState();
}

async function placeOrToggleMark(pageNum, px, py) {
  const pageState = getPageState(pageNum);
  const pageView = getPageView(pageNum);
  if (!pageState || !pageView || !state.activeMarkType || state.activeMarkType === "erase") return;

  const existing = findAnnotationAt(pageNum, px, py);
  pushUndoSnapshot(pageNum);

  if (existing) {
    pageState.annotations.splice(existing.index, 1);
  } else {
    const point = toRatioPoint(px, py, pageView.overlayCanvas);
    pageState.annotations.push({
      id: generateId("ann"),
      type: "mark",
      kind: state.activeMarkType,
      x: point.x,
      y: point.y
    });
  }

  redrawAnnotationsForPage(pageNum);
  await persistDocState();
}

async function eraseMarkAt(pageNum, px, py) {
  const pageState = getPageState(pageNum);
  if (!pageState) return;

  const existing = findAnnotationAt(pageNum, px, py);
  if (!existing) return;

  pushUndoSnapshot(pageNum);
  pageState.annotations.splice(existing.index, 1);
  redrawAnnotationsForPage(pageNum);
  await persistDocState();
}

function isPenEvent(event) {
  return event.pointerType === "pen";
}

function onPointerDown(event, pageNum) {
  if (!state.pdfDoc) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const pageView = getPageView(pageNum);
  if (!pageView || !pageView.overlayCanvas.width) return;

  const pos = getPointerPos(event, pageView.overlayCanvas);
  state.activePointerId = event.pointerId;

  if (state.mode === "study") {
    if (state.activeMarkType === "erase") {
      void eraseMarkAt(pageNum, pos.x, pos.y);
      event.preventDefault();
      return;
    }

    if (state.activeMarkType) {
      void placeOrToggleMark(pageNum, pos.x, pos.y);
      event.preventDefault();
      return;
    }

    const hit = findTopMaskAt(pageNum, pos.x, pos.y);
    if (hit) {
      hit.mask.userHidden = !hit.mask.userHidden;
      redrawOverlayForPage(pageNum);
      void persistDocState();
      event.preventDefault();
    }
    return;
  }

  if (!isPenEvent(event)) return;

  if (state.createTool === "eraser") {
    const hit = findTopMaskAt(pageNum, pos.x, pos.y);
    if (hit) {
      pushUndoSnapshot(pageNum);
      const pageState = getPageState(pageNum);
      pageState.masks.splice(hit.index, 1);
      redrawOverlayForPage(pageNum);
      void persistDocState();
    }
    event.preventDefault();
    return;
  }

  if (state.createTool === "line" || state.createTool === "rect") {
    state.drawing = true;
    state.drawingPage = pageNum;
    state.startX = pos.x;
    state.startY = pos.y;
    state.currentDraft = state.createTool === "line"
      ? createLineDraft(pos.x, pos.y, pageView.overlayCanvas)
      : createRectDraft(pos.x, pos.y, pageView.overlayCanvas);

    pageView.overlayCanvas.setPointerCapture(event.pointerId);
    setTouchMode(true);
    redrawOverlayForPage(pageNum);
    event.preventDefault();
  }
}

function onPointerMove(event, pageNum) {
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
  if (!state.drawing || !state.currentDraft || !isPenEvent(event)) return;
  if (state.drawingPage !== pageNum) return;

  const pageView = getPageView(pageNum);
  if (!pageView || !pageView.overlayCanvas.width) return;

  const pos = getPointerPos(event, pageView.overlayCanvas);

  if (state.currentDraft.type === "line") {
    const point = toRatioPoint(pos.x, pos.y, pageView.overlayCanvas);
    state.currentDraft.x2 = point.x;
    state.currentDraft.y2 = point.y;
  }

  if (state.currentDraft.type === "rect") {
    const start = toRatioPoint(state.startX, state.startY, pageView.overlayCanvas);
    const current = toRatioPoint(pos.x, pos.y, pageView.overlayCanvas);
    state.currentDraft.x = start.x;
    state.currentDraft.y = start.y;
    state.currentDraft.w = current.x - start.x;
    state.currentDraft.h = current.y - start.y;
  }

  redrawOverlayForPage(pageNum);
  event.preventDefault();
}

function onPointerUp(event, pageNum) {
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;

  if (state.drawing && state.drawingPage === pageNum) {
    state.drawing = false;
    void finalizeDraft(pageNum);
    setTouchMode(false);
  }

  state.activePointerId = null;
}

function onPointerCancel() {
  state.drawing = false;
  state.currentDraft = null;
  state.activePointerId = null;
  state.drawingPage = null;
  setTouchMode(false);
  redrawAllOverlays();
}

function scrollToPage(pageNum, smooth = true) {
  const pageView = getPageView(pageNum);
  if (!pageView) return;
  pageView.stage.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "start"
  });
}

function updateCurrentPageFromScroll() {
  if (!state.pageViews.size) return;

  const viewerRect = dom.viewerBody.getBoundingClientRect();
  const targetY = viewerRect.top + viewerRect.height * 0.35;
  let bestPage = state.currentPage;
  let bestDistance = Infinity;

  for (const [pageNum, pageView] of state.pageViews.entries()) {
    const rect = pageView.stage.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const distance = Math.abs(centerY - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = pageNum;
    }
  }

  if (bestPage !== state.currentPage) {
    state.currentPage = bestPage;
    updateHeader();
    void persistDocState();
    void ensureNeighborhoodRendered(bestPage);
  }
}

function onViewerScroll() {
  if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
  state.scrollRaf = requestAnimationFrame(() => {
    updateCurrentPageFromScroll();
  });
}

async function ensureNeighborhoodRendered(centerPage) {
  const targets = [
    centerPage,
    centerPage - 1,
    centerPage + 1,
    centerPage - 2,
    centerPage + 2
  ].filter((pageNum) => pageNum >= 1 && pageNum <= state.totalPages);

  for (const pageNum of targets) {
    await ensurePageRendered(pageNum);
  }
}

async function showAllMasks() {
  for (let pageNum = 1; pageNum <= state.totalPages; pageNum += 1) {
    const pageState = getPageState(pageNum);
    if (!pageState) continue;
    pageState.masks.forEach((mask) => {
      mask.userHidden = true;
    });
    redrawOverlayForPage(pageNum);
  }
  await persistDocState();
}

async function hideAllMasks() {
  for (let pageNum = 1; pageNum <= state.totalPages; pageNum += 1) {
    const pageState = getPageState(pageNum);
    if (!pageState) continue;
    pageState.masks.forEach((mask) => {
      mask.userHidden = false;
    });
    redrawOverlayForPage(pageNum);
  }
  await persistDocState();
}

function rerenderVisiblePages() {
  state.pageViews.forEach((pageView) => {
    pageView.rendered = false;
    pageView.rendering = false;
    pageView.stage.classList.add("placeholder");
    pageView.pdfCanvas.width = 0;
    pageView.pdfCanvas.height = 0;
    pageView.overlayCanvas.width = 0;
    pageView.overlayCanvas.height = 0;
    pageView.annotationLayer.innerHTML = "";
  });

  void ensureNeighborhoodRendered(state.currentPage);
}

function handleResize() {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    if (!dom.viewerScreen.classList.contains("active") || !state.pdfDoc) return;
    rerenderVisiblePages();
    scrollToPage(state.currentPage, false);
    updateCurrentPageFromScroll();
  }, 140);
}

async function openDocumentRecord(docMeta, pdfBlob) {
  const openToken = Date.now();
  state.docOpenToken = openToken;

  await closeCurrentDocument();

  state.docState = migrateDocShape(docMeta);
  state.currentPdfId = docMeta.id;
  state.currentPdfName = docMeta.name;
  state.pdfBlob = pdfBlob;
  state.currentPage = clamp(docMeta.lastPage || 1, 1, Math.max(docMeta.totalPages || 1, 1));

  const objectUrl = URL.createObjectURL(pdfBlob);
  state.pdfObjectUrl = objectUrl;

  try {
    state.pdfLoadingTask = pdfjsLib.getDocument(objectUrl);
    state.pdfDoc = await state.pdfLoadingTask.promise;
  } catch (error) {
    console.error(error);
    cleanupObjectURL();
    alert("PDFの読み込みに失敗しました。");
    return;
  }

  state.totalPages = state.pdfDoc.numPages;
  state.docState.totalPages = state.totalPages;
  if (state.currentPage > state.totalPages) {
    state.currentPage = 1;
  }

  await persistDocState();
  showViewer();
  updateToolUI();
  await buildPageSkeletons(openToken);
  if (openToken !== state.docOpenToken) return;

  setupIntersectionObserver();
  await ensureNeighborhoodRendered(state.currentPage);

  requestAnimationFrame(() => {
    scrollToPage(state.currentPage, false);
    updateCurrentPageFromScroll();
  });
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch (error) {
    console.error("SW registration failed:", error);
  }
}

async function checkForAppUpdate() {
  if (!("serviceWorker" in navigator)) {
    alert("この環境では更新確認に対応していません。");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("./");
    if (!registration) {
      alert("Service Worker が見つかりませんでした。");
      return;
    }

    let refreshed = false;
    const onControllerChange = () => {
      if (refreshed) return;
      refreshed = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    await registration.update();

    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
      return;
    }

    if (registration.installing) {
      registration.installing.addEventListener("statechange", () => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      });
      return;
    }

    alert(`Ver ${APP_VERSION} は最新です。`);
  } catch (error) {
    console.error(error);
    alert("更新確認に失敗しました。通信状態を確認してもう一度お試しください。");
  }
}

function bindEvents() {
  dom.pdfFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleFileSelect(file);
    dom.pdfFileInput.value = "";
  });

  dom.checkUpdateBtn.addEventListener("click", () => {
    void checkForAppUpdate();
  });

  dom.clearHistoryBtn.addEventListener("click", async () => {
    const ok = confirm("最近開いたPDFの履歴と保存データをすべて削除しますか？");
    if (!ok) return;
    await dbClearAllDocs();
    await closeCurrentDocument();
    showHome();
    await renderRecentList();
  });

  dom.backBtn.addEventListener("click", async () => {
    await persistDocState();
    showHome();
    await renderRecentList();
  });

  dom.createModeBtn.addEventListener("click", () => setMode("create"));
  dom.studyModeBtn.addEventListener("click", () => setMode("study"));
  dom.drawLineBtn.addEventListener("click", () => setCreateTool("line"));
  dom.drawRectBtn.addEventListener("click", () => setCreateTool("rect"));
  dom.eraserBtn.addEventListener("click", () => setCreateTool("eraser"));
  dom.undoBtn.addEventListener("click", () => {
    void undoLastAction();
  });
  dom.showAllBtn.addEventListener("click", () => {
    void showAllMasks();
  });
  dom.hideAllBtn.addEventListener("click", () => {
    void hideAllMasks();
  });

  dom.brushSizeInput.addEventListener("input", (event) => {
    state.brushWidth = Number(event.target.value || 18);
    updateBrushUI();
  });

  dom.colorChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".color-chip");
    if (!chip) return;
    state.brushColor = chip.dataset.color || state.brushColor;
    updateBrushUI();
  });

  dom.markTypeChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".mark-chip");
    if (!chip) return;
    const next = chip.dataset.mark || null;
    state.activeMarkType = state.activeMarkType === next ? null : next;
    updateMarkUI();
    updateHeader();
  });

  dom.viewerBody.addEventListener("scroll", onViewerScroll, { passive: true });
  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void persistDocState();
    }
  });

  window.addEventListener("beforeunload", () => {
    cleanupObjectURL();
  });
}

async function init() {
  bindEvents();
  await registerSW();
  await renderRecentList();
  updateBrushUI();
  updateMarkUI();
  updateToolUI();
  showHome();
}

void init();
