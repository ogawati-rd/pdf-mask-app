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

  const backBtn = document.getElementById("backBtn");
  const docTitle = document.getElementById("docTitle");
  const pageInfo = document.getElementById("pageInfo");
  const modeLabel = document.getElementById("modeLabel");

  const pdfStageWrap = document.getElementById("pdfStageWrap");
  const viewerBody = document.getElementById("viewerBody");

  const viewModeBtn = document.getElementById("viewModeBtn");
  const drawLineBtn = document.getElementById("drawLineBtn");
  const drawRectBtn = document.getElementById("drawRectBtn");
  const eraserBtn = document.getElementById("eraserBtn");
  const showAllBtn = document.getElementById("showAllBtn");
  const hideAllBtn = document.getElementById("hideAllBtn");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");

  const brushSizeInput = document.getElementById("brushSizeInput");
  const brushSizeValue = document.getElementById("brushSizeValue");
  const colorChips = document.getElementById("colorChips");

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
    tool: "view", // view | line | rect | eraser
    rendering: false,
    resizeTimer: null,

    // pointer interaction
    drawing: false,
    drawingPage: null,
    startX: 0,
    startY: 0,
    activePointerId: null,
    currentDraft: null,

    // brush
    brushWidth: 18,
    brushColor: "rgba(0,0,0,0.96)",

    // current persistent doc state
    docState: null,

    // rendered pages
    pageViews: new Map(),
    pagesContainer: null,

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

  function getPageState(pageNum) {
    if (!state.docState) return null;
    const key = String(pageNum);
    if (!state.docState.pages[key]) {
      state.docState.pages[key] = { masks: [] };
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
      pages: {}
    };
  }

  function isMaskVisible(mask) {
    return !mask.userHidden;
  }

  function getPointerPos(e, overlayCanvas) {
    const rect = overlayCanvas.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const y = clamp(e.clientY - rect.top, 0, rect.height);
    return { x, y, rect };
  }

  function toRatioPoint(px, py, overlayCanvas) {
    return {
      x: overlayCanvas.width ? px / overlayCanvas.width : 0,
      y: overlayCanvas.height ? py / overlayCanvas.height : 0
    };
  }

  function fromRatioPoint(rx, ry, overlayCanvas) {
    return {
      x: rx * overlayCanvas.width,
      y: ry * overlayCanvas.height
    };
  }

  function setTouchMode(disableScroll) {
    if (disableScroll) {
      viewerBody.classList.add("no-scroll");
    } else {
      viewerBody.classList.remove("no-scroll");
    }
  }

  function downloadMeta(doc) {
    const pagesCount = doc.pages ? Object.keys(doc.pages).length : 0;
    return `${formatDate(doc.updatedAt)} ・ ${doc.size.toLocaleString()} bytes ・ ${pagesCount}ページ保存`;
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
    const docs = await dbGetAllDocs();
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
      await dbPutDoc(existing);
    } else {
      existing.pdfBlob = file;
      existing.updatedAt = nowISO();
      await dbPutDoc(existing);
    }

    await openDocState(existing);
    await renderRecentList();
  }

  async function openSavedPdf(id) {
    const doc = await dbGetDoc(id);
    if (!doc || !doc.pdfBlob) {
      alert("保存されたPDFが見つかりませんでした。");
      return;
    }
    await openDocState(doc);
  }

  async function openDocState(doc) {
    cleanupObjectURL();
    clearPageViews();

    state.docState = doc;
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
    updateHeader();
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

    stage.append(pdfCanvas, overlayCanvas);

    const pageView = {
      pageNum,
      stage,
      pdfCanvas,
      overlayCanvas,
      pdfCtx: pdfCanvas.getContext("2d"),
      overlayCtx: overlayCanvas.getContext("2d"),
      width: 0,
      height: 0
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
    const scale = containerWidth / unscaled.width;
    const viewport = page.getViewport({ scale });

    pageView.width = Math.floor(viewport.width);
    pageView.height = Math.floor(viewport.height);

    pageView.pdfCanvas.width = pageView.width;
    pageView.pdfCanvas.height = pageView.height;
    pageView.pdfCanvas.style.width = `${viewport.width}px`;
    pageView.pdfCanvas.style.height = `${viewport.height}px`;

    pageView.overlayCanvas.width = pageView.width;
    pageView.overlayCanvas.height = pageView.height;
    pageView.overlayCanvas.style.width = `${viewport.width}px`;
    pageView.overlayCanvas.style.height = `${viewport.height}px`;

    pageView.stage.style.width = `${viewport.width}px`;
    pageView.stage.style.height = `${viewport.height}px`;

    pageView.pdfCtx.clearRect(0, 0, pageView.pdfCanvas.width, pageView.pdfCanvas.height);
    await page.render({
      canvasContext: pageView.pdfCtx,
      viewport
    }).promise;

    redrawOverlayForPage(pageNum);
  }

  function redrawAllOverlays() {
    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
      redrawOverlayForPage(pageNum);
    }
  }

  function redrawOverlayForPage(pageNum) {
    const pageView = getPageView(pageNum);
    const pageState = getPageState(pageNum);
    if (!pageView || !pageState) return;

    const ctx = pageView.overlayCtx;
    ctx.clearRect(0, 0, pageView.overlayCanvas.width, pageView.overlayCanvas.height);

    for (const mask of pageState.masks) {
      if (!isMaskVisible(mask)) continue;
      drawMask(ctx, pageView.overlayCanvas, mask, false);
    }

    if (state.currentDraft && state.drawingPage === pageNum) {
      drawMask(ctx, pageView.overlayCanvas, state.currentDraft, true);
    }
  }

  function drawMask(ctx, overlayCanvas, mask, isDraft) {
    const color = mask.color || "rgba(0,0,0,0.96)";

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = isDraft ? 0.88 : 1;

    if (mask.type === "rect") {
      const p = fromRatioPoint(mask.x, mask.y, overlayCanvas);
      const size = fromRatioPoint(mask.w, mask.h, overlayCanvas);
      ctx.fillRect(p.x, p.y, size.x, size.y);
    }

    if (mask.type === "line") {
      if (!mask.points || mask.points.length < 2) {
        ctx.restore();
        return;
      }

      const widthPx = (mask.widthRatio || 0.02) * overlayCanvas.width;
      ctx.lineWidth = Math.max(4, widthPx);
      ctx.beginPath();

      const first = fromRatioPoint(mask.points[0].x, mask.points[0].y, overlayCanvas);
      ctx.moveTo(first.x, first.y);

      for (let i = 1; i < mask.points.length; i++) {
        const p = fromRatioPoint(mask.points[i].x, mask.points[i].y, overlayCanvas);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  // ------------------------------
  // Header / UI
  // ------------------------------
  function updateHeader() {
    docTitle.textContent = state.currentPdfName || "-";
    pageInfo.textContent = `${state.currentPage} / ${state.totalPages || 0}`;

    const modeMap = {
      view: "閲覧",
      line: "線描画",
      rect: "四角描画",
      eraser: "消しゴム"
    };
    modeLabel.textContent = modeMap[state.tool] || "閲覧";
  }

  function updateToolUI() {
    [viewModeBtn, drawLineBtn, drawRectBtn, eraserBtn].forEach((btn) => btn.classList.remove("active"));
    if (state.tool === "view") viewModeBtn.classList.add("active");
    if (state.tool === "line") drawLineBtn.classList.add("active");
    if (state.tool === "rect") drawRectBtn.classList.add("active");
    if (state.tool === "eraser") eraserBtn.classList.add("active");

    setTouchMode(state.tool !== "view" && state.drawing);
    updateHeader();
    updateBrushUI();
  }

  function setTool(tool) {
    state.tool = tool;
    state.currentDraft = null;
    state.drawing = false;
    state.drawingPage = null;
    updateToolUI();
    redrawAllOverlays();
  }

  // ------------------------------
  // Mask creation / hit testing
  // ------------------------------
  function createLineDraft(startX, startY, overlayCanvas) {
    const p = toRatioPoint(startX, startY, overlayCanvas);
    return {
      id: generateId("mask"),
      type: "line",
      widthRatio: state.brushWidth / Math.max(overlayCanvas.width, 1),
      color: state.brushColor,
      userHidden: false,
      points: [p]
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

  function finalizeDraft(pageNum) {
    const pageState = getPageState(pageNum);
    if (!pageState || !state.currentDraft) return;

    const draft = state.currentDraft;

    if (draft.type === "line") {
      if (!draft.points || draft.points.length < 2) {
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

    pageState.masks.push(draft);
    state.currentDraft = null;
    state.drawingPage = null;
    redrawOverlayForPage(pageNum);
    persistPageState();
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
    if (!mask.points || mask.points.length < 2) return false;
    const widthPx = Math.max(8, (mask.widthRatio || 0.02) * overlayCanvas.width);
    const threshold = widthPx * 0.7 + 8;

    for (let i = 1; i < mask.points.length; i++) {
      const a = fromRatioPoint(mask.points[i - 1].x, mask.points[i - 1].y, overlayCanvas);
      const b = fromRatioPoint(mask.points[i].x, mask.points[i].y, overlayCanvas);
      const d = distancePointToSegment(px, py, a.x, a.y, b.x, b.y);
      if (d <= threshold) return true;
    }
    return false;
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

    if (state.tool === "view") {
      const hit = findTopMaskAt(pageNum, pos.x, pos.y, true);
      if (hit) {
        hit.mask.userHidden = !hit.mask.userHidden;
        redrawOverlayForPage(pageNum);
        persistPageState();
        e.preventDefault();
      }
      return;
    }

    // 描画・消しゴムは Apple Pencil のみ
    if (!isPenEvent(e)) {
      return;
    }

    if (state.tool === "eraser") {
      const hit = findTopMaskAt(pageNum, pos.x, pos.y, true);
      if (hit) {
        const pageState = getPageState(pageNum);
        pageState.masks.splice(hit.index, 1);
        redrawOverlayForPage(pageNum);
        persistPageState();
      }
      e.preventDefault();
      return;
    }

    if (state.tool === "line" || state.tool === "rect") {
      state.drawing = true;
      state.drawingPage = pageNum;
      state.startX = pos.x;
      state.startY = pos.y;
      state.currentDraft = state.tool === "line"
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
      const points = state.currentDraft.points;
      const last = points[points.length - 1];
      const dx = Math.abs((last?.x ?? 0) - p.x);
      const dy = Math.abs((last?.y ?? 0) - p.y);

      if (dx + dy > 0.0025) {
        points.push(p);
      }
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

  async function goToPage(pageNum) {
    if (!state.pdfDoc) return;
    const next = clamp(pageNum, 1, state.totalPages);
    state.currentPage = next;
    updateHeader();
    await persistDocState();
    scrollToPage(next, true);
  }

  async function showAllMasks() {
  // 全表示 = 全てのカバーを外す
  for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
    const pageState = getPageState(pageNum);
    if (!pageState) continue;
    pageState.masks.forEach((m) => { m.userHidden = true; });
    redrawOverlayForPage(pageNum);
  }
  await persistPageState();
}

async function hideAllMasks() {
  // 全隠し = 全てのカバーをつける
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

  viewModeBtn.addEventListener("click", () => setTool("view"));
  drawLineBtn.addEventListener("click", () => setTool("line"));
  drawRectBtn.addEventListener("click", () => setTool("rect"));
  eraserBtn.addEventListener("click", () => setTool("eraser"));

  showAllBtn.addEventListener("click", showAllMasks);
  hideAllBtn.addEventListener("click", hideAllMasks);

  if (prevPageBtn) {
    prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
  }
  if (nextPageBtn) {
    nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
  }

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
    updateToolUI();
    showHome();
  }

  init();

  window.addEventListener("beforeunload", () => {
    cleanupObjectURL();
  });
})();