(() => {
  "use strict";

  if (!window.pdfjsLib) {
    alert("pdf.mjs が見つかりません。同じフォルダに配置してください。");
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf-mask-app/pdf.worker.mjs";

  // ------------------------------
  // DOM
  // ------------------------------
  const homeScreen = document.getElementById("homeScreen");
  const viewerScreen = document.getElementById("viewerScreen");
  const pdfFileInput = document.getElementById("pdfFileInput");
  const recentList = document.getElementById("recentList");
  const recentEmpty = document.getElementById("recentEmpty");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const checkUpdateBtn = document.getElementById("checkUpdateBtn");

  const backBtn = document.getElementById("backBtn");
  const docTitle = document.getElementById("docTitle");
  const pageInfo = document.getElementById("pageInfo");

  const pdfStageWrap = document.getElementById("pdfStageWrap");
  const viewerBody = document.getElementById("viewerBody");

  const createTools = document.getElementById("createTools");
  const studyTools = document.getElementById("studyTools");

  const createModeBtn = document.getElementById("createModeBtn");
  const studyModeBtn = document.getElementById("studyModeBtn");

  const drawLineBtn = document.getElementById("drawLineBtn");
  const drawRectBtn = document.getElementById("drawRectBtn");
  const eraserBtn = document.getElementById("eraserBtn");
  const undoBtn = document.getElementById("undoBtn");

  const showAllBtn = document.getElementById("showAllBtn");
  const hideAllBtn = document.getElementById("hideAllBtn");

  const brushSizeInput = document.getElementById("brushSizeInput");
  const brushSizeValue = document.getElementById("brushSizeValue");
  const colorChips = document.getElementById("colorChips");
  const markTypeChips = document.getElementById("markTypeChips");

  // ------------------------------
  // App state
  // ------------------------------
  const state = {
    pdfDoc: null,
    pdfBlob: null,
    pdfObjectUrl: null,
    currentPdfId: null,
    currentPdfName: "",
    currentPage: 1,
    totalPages: 0,
    mode: "study", // create | study
    createTool: "line", // line | rect | eraser
    rendering: false,
    resizeTimer: null,

    drawing: false,
    drawingPage: null,
    startX: 0,
    startY: 0,
    activePointerId: null,
    currentDraft: null,

    brushWidth: 18,
    brushColor: "rgba(0,0,0,0.96)",

    activeMarkType: null, // star | review | question | done | erase | null

    docState: null,

    pageViews: new Map(),
    pagesContainer: null,

    undoStack: [],

    scrollRaf: null
  };

  // ------------------------------
  // IndexedDB
  // ------------------------------
  const DB_NAME = "pdf-memorize-pwa-db";
  const DB_VERSION = 1;
  const STORE_DOCS = "documents";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_DOCS)) {
          const store = db.createObjectStore(STORE_DOCS, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllDocs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, "readonly");
      const store = tx.objectStore(STORE_DOCS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetDoc(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, "readonly");
      const store = tx.objectStore(STORE_DOCS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutDoc(doc) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, "readwrite");
      const store = tx.objectStore(STORE_DOCS);
      const req = store.put(doc);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteDoc(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, "readwrite");
      const store = tx.objectStore(STORE_DOCS);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbClearAllDocs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, "readwrite");
      const store = tx.objectStore(STORE_DOCS);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ------------------------------
  // Utilities
  // ------------------------------
  function makePdfId(fileLike) {
    return `pdf::${fileLike.name}::${fileLike.size}::${fileLike.lastModified}`;
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString("ja-JP");
    } catch {
      return iso || "-";
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function generateId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function formatFileSizeMB(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }

  function getPageState(pageNum) {
    if (!state.docState) return null;
    const key = String(pageNum);
    if (!state.docState.pages[key]) {
      state.docState.pages[key] = { masks: [], annotations: [] };
    } else {
      if (!Array.isArray(state.docState.pages[key].masks)) {
        state.docState.pages[key].masks = [];
      }
      if (!Array.isArray(state.docState.pages[key].annotations)) {
        state.docState.pages[key].annotations = [];
      }
    }
    return state.docState.pages[key];
  }

  function createEmptyDocState({ id, name, size, lastModified, pdfBlob }) {
    return {
      id,
      name,
      size,
      lastModified,
      pdfBlob,
      updatedAt: nowISO(),
      totalPages: 0,
      lastPage: 1,
      pages: {},
      favorite: false,
      schemaVersion: 2
    };
  }

  function migrateDocShape(doc) {
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
    doc.schemaVersion = 2;
    return doc;
  }

  function isMaskVisible(mask) {
    return !mask.userHidden;
  }

  function getCanvasMetrics(overlayCanvas) {
    const rect = overlayCanvas.getBoundingClientRect();
    return {
      rect,
      cssWidth: rect.width,
      cssHeight: rect.height,
      pixelWidth: overlayCanvas.width,
      pixelHeight: overlayCanvas.height,
      scaleX: rect.width ? overlayCanvas.width / rect.width : 1,
      scaleY: rect.height ? overlayCanvas.height / rect.height : 1
    };
  }

  function getPointerPos(e, overlayCanvas) {
    const { rect, cssWidth, cssHeight } = getCanvasMetrics(overlayCanvas);
    const x = clamp(e.clientX - rect.left, 0, cssWidth);
    const y = clamp(e.clientY - rect.top, 0, cssHeight);
    return { x, y, rect };
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

  function setTouchMode(disableScroll) {
    viewerBody.classList.toggle("no-scroll", disableScroll);
  }

  function downloadMeta(doc) {
    const pagesCount = doc.totalPages || 0;
    return `${formatDate(doc.updatedAt)} ・ ${formatFileSizeMB(doc.size)} ・ ${pagesCount}ページ`;
  }

  function isPenEvent(e) {
    return e.pointerType === "pen";
  }

  function updateBrushUI() {
    if (brushSizeValue) brushSizeValue.textContent = String(state.brushWidth);

    if (colorChips) {
      const chips = colorChips.querySelectorAll(".color-chip");
      chips.forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.color === state.brushColor);
      });
    }
  }

  function getPageView(pageNum) {
    return state.pageViews.get(pageNum) || null;
  }

  function clearPageViews() {
    state.pageViews.clear();
    if (pdfStageWrap) {
      pdfStageWrap.innerHTML = "";
    }
    state.pagesContainer = null;
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

  function pushUndoSnapshot(pageNum) {
    const pageState = getPageState(pageNum);
    if (!pageState) return;
    state.undoStack.push({
      pageNum,
      pageState: deepClone(pageState)
    });
    if (state.undoStack.length > 50) {
      state.undoStack.shift();
    }
  }

  async function undoLastAction() {
    if (!state.undoStack.length) return;
    const last = state.undoStack.pop();
    if (!last) return;
    state.docState.pages[String(last.pageNum)] = deepClone(last.pageState);
    redrawPageDecorations(last.pageNum);
    await persistPageState();
  }

  // ------------------------------
  // UI helpers
  // ------------------------------
  function updateMarkUI() {
    if (!markTypeChips) return;
    const chips = markTypeChips.querySelectorAll(".mark-chip");
    chips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.mark === state.activeMarkType);
    });
  }

 function updateHeader() {
  docTitle.textContent = state.currentPdfName || "-";
  pageInfo.textContent = `${state.currentPage} / ${state.totalPages || 0}`;
}

  function updateToolUI() {
    drawLineBtn.classList.toggle("active", state.mode === "create" && state.createTool === "line");
    drawRectBtn.classList.toggle("active", state.mode === "create" && state.createTool === "rect");
    eraserBtn.classList.toggle("active", state.mode === "create" && state.createTool === "eraser");

    createTools.classList.toggle("is-hidden", state.mode !== "create");
    studyTools.classList.toggle("is-hidden", state.mode !== "study");

    createModeBtn.classList.toggle("active", state.mode === "create");
    studyModeBtn.classList.toggle("active", state.mode === "study");

    setTouchMode(state.mode === "create" && state.drawing);
    updateBrushUI();
    updateMarkUI();
    updateHeader();
  }

  function setCreateTool(tool) {
    state.createTool = tool;
    state.currentDraft = null;
    state.drawing = false;
    state.drawingPage = null;
    redrawAllOverlays();
    updateToolUI();
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

  // ------------------------------
  // Service Worker
  // ------------------------------
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./service-worker.js");
    } catch (err) {
      console.error("SW registration failed:", err);
    }
  }

  async function checkForAppUpdate() {
    if (!("serviceWorker" in navigator)) {
      alert("この環境では更新確認に対応していません。");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        alert("Service Worker が見つかりませんでした。Safariで一度開き直してから試してください。");
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

      alert("最新の状態です。");
    } catch (err) {
      console.error(err);
      alert("更新確認に失敗しました。通信状態を確認してもう一度お試しください。");
    }
  }

  // ------------------------------
  // Screen control
  // ------------------------------
  function showHome() {
    viewerScreen.classList.remove("active");
    homeScreen.classList.add("active");
  }

  function showViewer() {
    homeScreen.classList.remove("active");
    viewerScreen.classList.add("active");
  }

  // ------------------------------
  // Recent list
  // ------------------------------
  async function renderRecentList() {
    const docs = (await dbGetAllDocs()).map(migrateDocShape);
    docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    recentList.innerHTML = "";
    recentEmpty.style.display = docs.length ? "none" : "block";

    docs.forEach((doc) => {
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

      const openBtn = document.createElement("button");
      openBtn.className = "recent-open-btn";
      openBtn.type = "button";
      openBtn.textContent = "開く";
      openBtn.addEventListener("click", () => openSavedPdf(doc.id));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "recent-delete-btn";
      deleteBtn.type = "button";
      deleteBtn.textContent = "削除";
      deleteBtn.addEventListener("click", async () => {
        const ok = confirm(`「${doc.name}」を履歴から削除しますか？`);
        if (!ok) return;
        await dbDeleteDoc(doc.id);
        await renderRecentList();
      });

      actions.append(openBtn, deleteBtn);
      item.append(title, meta, actions);
      recentList.appendChild(item);
    });
  }

  // ------------------------------
  // Open PDF
  // ------------------------------
  async function handleFileSelect(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      alert("PDFファイルを選択してください。");
      return;
    }

    const id = makePdfId(file);
    let existing = await dbGetDoc(id);

    if (!existing) {
      existing = createEmptyDocState({
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        pdfBlob: file
      });
    } else {
      existing = migrateDocShape(existing);
      existing.pdfBlob = file;
      existing.updatedAt = nowISO();
      existing.size = file.size;
      existing.lastModified = file.lastModified;
    }

    await dbPutDoc(existing);
    await openDocState(existing);
    await renderRecentList();
  }

  async function openSavedPdf(id) {
    const doc = await dbGetDoc(id);
    if (!doc || !doc.pdfBlob) {
      alert("保存されたPDFが見つかりませんでした。");
      return;
    }
    await openDocState(migrateDocShape(doc));
  }

  async function openDocState(doc) {
    cleanupObjectURL();
    clearPageViews();
    state.undoStack = [];

    state.docState = migrateDocShape(doc);
    state.currentPdfId = doc.id;
    state.currentPdfName = doc.name;
    state.pdfBlob = doc.pdfBlob;
    state.currentPage = clamp(doc.lastPage || 1, 1, Math.max(doc.totalPages || 1, 1));

    const url = URL.createObjectURL(doc.pdfBlob);
    state.pdfObjectUrl = url;

    try {
      state.pdfDoc = await pdfjsLib.getDocument(url).promise;
    } catch (err) {
      console.error(err);
      alert("PDFの読み込みに失敗しました。");
      return;
    }

    state.totalPages = state.pdfDoc.numPages;
    state.docState.totalPages = state.totalPages;
    if (state.currentPage > state.totalPages) state.currentPage = 1;

    await persistDocState();
    showViewer();
    updateToolUI();
    await renderAllPages();

    requestAnimationFrame(() => {
      scrollToPage(state.currentPage, false);
      updateCurrentPageFromScroll();
    });
  }

  function cleanupObjectURL() {
    if (state.pdfObjectUrl) {
      URL.revokeObjectURL(state.pdfObjectUrl);
      state.pdfObjectUrl = null;
    }
  }

  // ------------------------------
  // Persist
  // ------------------------------
  async function persistDocState() {
    if (!state.docState) return;
    state.docState.updatedAt = nowISO();
    state.docState.lastPage = state.currentPage;
    state.docState.totalPages = state.totalPages;
    await dbPutDoc(state.docState);
  }

  async function persistPageState() {
    await persistDocState();
  }

  // ------------------------------
  // Render all pages
  // ------------------------------
  function createPagesContainer() {
    const container = document.createElement("div");
    container.className = "pdf-pages-stack";
    return container;
  }

  function createPageStage(pageNum) {
    const stage = document.createElement("div");
    stage.className = "pdf-stage pdf-page-stage";
    stage.dataset.page = String(pageNum);

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
      width: 0,
      height: 0,
      cssWidth: 0,
      cssHeight: 0,
      dpr: 1
    };

    overlayCanvas.addEventListener("pointerdown", (e) => onPointerDown(e, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointermove", (e) => onPointerMove(e, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointerup", (e) => onPointerUp(e, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointercancel", () => onPointerCancel(), { passive: false });

    return pageView;
  }

  async function renderAllPages() {
    if (!state.pdfDoc || state.rendering) return;

    state.rendering = true;
    clearPageViews();

    state.pagesContainer = createPagesContainer();
    pdfStageWrap.appendChild(state.pagesContainer);

    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
      const pageView = createPageStage(pageNum);
      state.pageViews.set(pageNum, pageView);
      state.pagesContainer.appendChild(pageView.stage);
      await renderPdfPage(pageNum);
    }

    updateHeader();
    state.rendering = false;
  }

  async function renderPdfPage(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const pageView = getPageView(pageNum);
    if (!pageView) return;

    const unscaled = page.getViewport({ scale: 1 });
    const containerWidth = Math.max(320, pdfStageWrap.clientWidth - 28);
    const baseScale = containerWidth / unscaled.width;

    const rawDpr = window.devicePixelRatio || 1;
    const dpr = Math.min(rawDpr, 2);

    const cssViewport = page.getViewport({ scale: baseScale });
    const renderViewport = page.getViewport({ scale: baseScale * dpr });

    pageView.dpr = dpr;
    pageView.cssWidth = cssViewport.width;
    pageView.cssHeight = cssViewport.height;
    pageView.width = Math.floor(renderViewport.width);
    pageView.height = Math.floor(renderViewport.height);

    pageView.pdfCanvas.width = pageView.width;
    pageView.pdfCanvas.height = pageView.height;
    pageView.pdfCanvas.style.width = `${cssViewport.width}px`;
    pageView.pdfCanvas.style.height = `${cssViewport.height}px`;

    pageView.overlayCanvas.width = pageView.width;
    pageView.overlayCanvas.height = pageView.height;
    pageView.overlayCanvas.style.width = `${cssViewport.width}px`;
    pageView.overlayCanvas.style.height = `${cssViewport.height}px`;

    pageView.annotationLayer.style.width = `${cssViewport.width}px`;
    pageView.annotationLayer.style.height = `${cssViewport.height}px`;

    pageView.stage.style.width = `${cssViewport.width}px`;
    pageView.stage.style.height = `${cssViewport.height}px`;

    pageView.pdfCtx.setTransform(1, 0, 0, 1, 0, 0);
    pageView.pdfCtx.clearRect(0, 0, pageView.pdfCanvas.width, pageView.pdfCanvas.height);

    await page.render({
      canvasContext: pageView.pdfCtx,
      viewport: renderViewport
    }).promise;

    redrawPageDecorations(pageNum);
  }

  function redrawAllOverlays() {
    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
      redrawOverlayForPage(pageNum);
      redrawAnnotationsForPage(pageNum);
    }
  }

  function redrawPageDecorations(pageNum) {
    redrawOverlayForPage(pageNum);
    redrawAnnotationsForPage(pageNum);
  }

  function drawMask(ctx, overlayCanvas, mask, isDraft) {
    const color = mask.color || "rgba(0,0,0,0.96)";
    const metrics = getCanvasMetrics(overlayCanvas);

    ctx.save();
    ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.globalAlpha = isDraft ? 0.88 : 1;

    if (mask.type === "rect") {
      const p = fromRatioPoint(mask.x, mask.y, overlayCanvas);
      const size = fromRatioPoint(mask.w, mask.h, overlayCanvas);
      ctx.fillRect(p.x, p.y, size.x, size.y);
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
      const len = Math.hypot(dx, dy);
      if (len < 1) {
        ctx.restore();
        return;
      }

      const nx = -dy / len;
      const ny = dx / len;
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
    if (!pageView || !pageState) return;

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
    if (!pageView || !pageState) return;

    pageView.annotationLayer.innerHTML = "";

    for (const ann of pageState.annotations) {
      if (ann.type !== "mark") continue;

      const p = fromRatioPoint(ann.x, ann.y, pageView.overlayCanvas);
      const el = document.createElement("div");
      el.className = `annotation-mark mark-${ann.kind}`;
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.textContent = getMarkSymbol(ann.kind);
      pageView.annotationLayer.appendChild(el);
    }
  }

  // ------------------------------
  // Hit testing
  // ------------------------------
  function hitTestRect(mask, px, py, overlayCanvas) {
    const pos = fromRatioPoint(mask.x, mask.y, overlayCanvas);
    const size = fromRatioPoint(mask.w, mask.h, overlayCanvas);
    return px >= pos.x && px <= pos.x + size.x && py >= pos.y && py <= pos.y + size.y;
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

  function findTopMaskAt(pageNum, px, py, includeHidden = true) {
    const pageState = getPageState(pageNum);
    const pageView = getPageView(pageNum);
    if (!pageState || !pageView) return null;

    for (let i = pageState.masks.length - 1; i >= 0; i--) {
      const mask = pageState.masks[i];
      if (!includeHidden && !isMaskVisible(mask)) continue;

      const hit = mask.type === "rect"
        ? hitTestRect(mask, px, py, pageView.overlayCanvas)
        : hitTestLine(mask, px, py, pageView.overlayCanvas);

      if (hit) return { mask, index: i };
    }
    return null;
  }

  function findAnnotationAt(pageNum, px, py) {
    const pageState = getPageState(pageNum);
    const pageView = getPageView(pageNum);
    if (!pageState || !pageView) return null;

    for (let i = pageState.annotations.length - 1; i >= 0; i--) {
      const ann = pageState.annotations[i];
      if (ann.type !== "mark") continue;
      const p = fromRatioPoint(ann.x, ann.y, pageView.overlayCanvas);
      const d = Math.hypot(px - p.x, py - p.y);
      if (d <= 22) return { ann, index: i };
    }
    return null;
  }

  // ------------------------------
  // Mask creation / annotations
  // ------------------------------
  function createLineDraft(startX, startY, overlayCanvas) {
    const p = toRatioPoint(startX, startY, overlayCanvas);
    const metrics = getCanvasMetrics(overlayCanvas);

    return {
      id: generateId("mask"),
      type: "line",
      widthRatio: state.brushWidth / Math.max(metrics.cssWidth, 1),
      color: state.brushColor,
      userHidden: false,
      x1: p.x,
      y1: p.y,
      x2: p.x,
      y2: p.y
    };
  }

  function createRectDraft(startX, startY, overlayCanvas) {
    const p = toRatioPoint(startX, startY, overlayCanvas);
    return {
      id: generateId("mask"),
      type: "rect",
      x: p.x,
      y: p.y,
      w: 0,
      h: 0,
      color: state.brushColor,
      userHidden: false
    };
  }

  function normalizeRectDraft(rect) {
    if (rect.w < 0) {
      rect.x = rect.x + rect.w;
      rect.w = Math.abs(rect.w);
    }
    if (rect.h < 0) {
      rect.y = rect.y + rect.h;
      rect.h = Math.abs(rect.h);
    }
    rect.x = clamp(rect.x, 0, 1);
    rect.y = clamp(rect.y, 0, 1);
    rect.w = clamp(rect.w, 0, 1);
    rect.h = clamp(rect.h, 0, 1);
  }

  function finalizeDraft(pageNum) {
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
    persistPageState();
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
      const p = toRatioPoint(px, py, pageView.overlayCanvas);
      pageState.annotations.push({
        id: generateId("ann"),
        type: "mark",
        kind: state.activeMarkType,
        x: p.x,
        y: p.y
      });
    }

    redrawAnnotationsForPage(pageNum);
    await persistPageState();
  }

  async function eraseMarkAt(pageNum, px, py) {
    const pageState = getPageState(pageNum);
    if (!pageState) return;

    const existing = findAnnotationAt(pageNum, px, py);
    if (!existing) return;

    pushUndoSnapshot(pageNum);
    pageState.annotations.splice(existing.index, 1);
    redrawAnnotationsForPage(pageNum);
    await persistPageState();
  }

  // ------------------------------
  // Pointer events
  // ------------------------------
  function onPointerDown(e, pageNum) {
    if (!state.pdfDoc) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const pageView = getPageView(pageNum);
    if (!pageView) return;

    const pos = getPointerPos(e, pageView.overlayCanvas);
    state.activePointerId = e.pointerId;

    if (state.mode === "study") {
      if (state.activeMarkType === "erase") {
        eraseMarkAt(pageNum, pos.x, pos.y);
        e.preventDefault();
        return;
      }

      if (state.activeMarkType) {
        placeOrToggleMark(pageNum, pos.x, pos.y);
        e.preventDefault();
        return;
      }

      const hit = findTopMaskAt(pageNum, pos.x, pos.y, true);
      if (hit) {
        hit.mask.userHidden = !hit.mask.userHidden;
        redrawOverlayForPage(pageNum);
        persistPageState();
        e.preventDefault();
      }
      return;
    }

    if (!isPenEvent(e)) {
      return;
    }

    if (state.createTool === "eraser") {
      const hit = findTopMaskAt(pageNum, pos.x, pos.y, true);
      if (hit) {
        pushUndoSnapshot(pageNum);
        const pageState = getPageState(pageNum);
        pageState.masks.splice(hit.index, 1);
        redrawOverlayForPage(pageNum);
        persistPageState();
      }
      e.preventDefault();
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

      pageView.overlayCanvas.setPointerCapture(e.pointerId);
      setTouchMode(true);
      redrawOverlayForPage(pageNum);
      e.preventDefault();
    }
  }

  function onPointerMove(e, pageNum) {
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    if (!state.drawing || !state.currentDraft) return;
    if (!isPenEvent(e)) return;
    if (state.drawingPage !== pageNum) return;

    const pageView = getPageView(pageNum);
    if (!pageView) return;

    const pos = getPointerPos(e, pageView.overlayCanvas);

    if (state.currentDraft.type === "line") {
      const p = toRatioPoint(pos.x, pos.y, pageView.overlayCanvas);
      state.currentDraft.x2 = p.x;
      state.currentDraft.y2 = p.y;
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
    e.preventDefault();
  }

  function onPointerUp(e, pageNum) {
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;

    if (state.drawing && state.drawingPage === pageNum) {
      state.drawing = false;
      finalizeDraft(pageNum);
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

  // ------------------------------
  // Page navigation / scroll
  // ------------------------------
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

    const viewerRect = viewerBody.getBoundingClientRect();
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
      persistDocState();
    }
  }

  function onViewerScroll() {
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = requestAnimationFrame(() => {
      updateCurrentPageFromScroll();
    });
  }

  async function showAllMasks() {
    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
      const pageState = getPageState(pageNum);
      if (!pageState) continue;
      pageState.masks.forEach((m) => { m.userHidden = true; });
      redrawOverlayForPage(pageNum);
    }
    await persistPageState();
  }

  async function hideAllMasks() {
    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
      const pageState = getPageState(pageNum);
      if (!pageState) continue;
      pageState.masks.forEach((m) => { m.userHidden = false; });
      redrawOverlayForPage(pageNum);
    }
    await persistPageState();
  }

  // ------------------------------
  // Resize
  // ------------------------------
  function handleResize() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(async () => {
      if (viewerScreen.classList.contains("active") && state.pdfDoc) {
        const keepPage = state.currentPage;
        await renderAllPages();
        scrollToPage(keepPage, false);
        updateCurrentPageFromScroll();
      }
    }, 120);
  }

  // ------------------------------
  // Events
  // ------------------------------
  pdfFileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleFileSelect(file);
    pdfFileInput.value = "";
  });

  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener("click", checkForAppUpdate);
  }

  clearHistoryBtn.addEventListener("click", async () => {
    const ok = confirm("最近開いたPDFの履歴と保存データをすべて削除しますか？");
    if (!ok) return;
    await dbClearAllDocs();
    await renderRecentList();
  });

  backBtn.addEventListener("click", async () => {
    await persistDocState();
    showHome();
    await renderRecentList();
  });

  createModeBtn.addEventListener("click", () => setMode("create"));
  studyModeBtn.addEventListener("click", () => setMode("study"));

  drawLineBtn.addEventListener("click", () => setCreateTool("line"));
  drawRectBtn.addEventListener("click", () => setCreateTool("rect"));
  eraserBtn.addEventListener("click", () => setCreateTool("eraser"));
  undoBtn.addEventListener("click", undoLastAction);

  showAllBtn.addEventListener("click", showAllMasks);
  hideAllBtn.addEventListener("click", hideAllMasks);

  if (brushSizeInput) {
    brushSizeInput.addEventListener("input", (e) => {
      state.brushWidth = Number(e.target.value || 18);
      updateBrushUI();
    });
  }

  if (colorChips) {
    colorChips.addEventListener("click", (e) => {
      const chip = e.target.closest(".color-chip");
      if (!chip) return;
      state.brushColor = chip.dataset.color || state.brushColor;
      updateBrushUI();
    });
  }

  if (markTypeChips) {
    markTypeChips.addEventListener("click", (e) => {
      const chip = e.target.closest(".mark-chip");
      if (!chip) return;
      const next = chip.dataset.mark || null;
      state.activeMarkType = state.activeMarkType === next ? null : next;
      updateMarkUI();
      updateHeader();
    });
  }

  viewerBody.addEventListener("scroll", onViewerScroll, { passive: true });

  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      persistDocState();
    }
  });

  // ------------------------------
  // Init
  // ------------------------------
  async function init() {
    await registerSW();
    await renderRecentList();
    updateBrushUI();
    updateMarkUI();
    updateToolUI();
    showHome();
  }

  init();

  window.addEventListener("beforeunload", () => {
    cleanupObjectURL();
  });
})();