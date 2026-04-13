(() => {
  "use strict";

  // pdf.js local worker
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
  const guideModeLabel = document.getElementById("guideModeLabel");

  const pdfCanvas = document.getElementById("pdfCanvas");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const pdfStage = document.getElementById("pdfStage");
  const pdfStageWrap = document.getElementById("pdfStageWrap");
  const viewerBody = document.getElementById("viewerBody");
  const guideLine = document.getElementById("guideLine");

  const viewModeBtn = document.getElementById("viewModeBtn");
  const drawLineBtn = document.getElementById("drawLineBtn");
  const drawRectBtn = document.getElementById("drawRectBtn");
  const eraserBtn = document.getElementById("eraserBtn");
  const guideModeBtn = document.getElementById("guideModeBtn");
  const showAllBtn = document.getElementById("showAllBtn");
  const hideAllBtn = document.getElementById("hideAllBtn");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");

  const pdfCtx = pdfCanvas.getContext("2d");
  const overlayCtx = overlayCanvas.getContext("2d");

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
    currentViewport: null,

    // pointer interaction
    drawing: false,
    dragGuide: false,
    startX: 0,
    startY: 0,
    activePointerId: null,
    currentDraft: null,
    lastTapMaskId: null,

    // current persistent doc state
    docState: null
  };

  const GUIDE_MODES = ["none", "hideBelow", "hideAbove"];
  const MASK_LINE_WIDTH = 18;
  const GUIDE_HIT_PX = 22;

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

  function getCurrentPageState() {
    if (!state.docState) return null;
    if (!state.docState.pages[String(state.currentPage)]) {
      state.docState.pages[String(state.currentPage)] = {
        masks: [],
        guidelineY: 0.5,
        guidelineMode: "none"
      };
    }
    return state.docState.pages[String(state.currentPage)];
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

  function getDisplaySize() {
    return {
      width: overlayCanvas.width,
      height: overlayCanvas.height
    };
  }

  function getMaskCenterRatioY(mask) {
    if (mask.type === "rect") {
      return mask.y + mask.h / 2;
    }
    if (mask.type === "line") {
      if (!mask.points.length) return 0;
      let sum = 0;
      for (const p of mask.points) sum += p.y;
      return sum / mask.points.length;
    }
    return 0;
  }

  function passesGuideFilter(mask, pageState) {
    const centerY = getMaskCenterRatioY(mask);
    const lineY = pageState.guidelineY ?? 0.5;
    const guideMode = pageState.guidelineMode ?? "none";

    if (guideMode === "hideBelow" && centerY > lineY) return false;
    if (guideMode === "hideAbove" && centerY < lineY) return false;
    return true;
  }

  function isMaskVisible(mask, pageState) {
    if (mask.userHidden) return false;
    return passesGuideFilter(mask, pageState);
  }

  function getPointerPos(e) {
    const rect = overlayCanvas.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const y = clamp(e.clientY - rect.top, 0, rect.height);
    return { x, y, rect };
  }

  function toRatioPoint(px, py) {
    const { width, height } = getDisplaySize();
    return {
      x: width ? px / width : 0,
      y: height ? py / height : 0
    };
  }

  function fromRatioPoint(rx, ry) {
    const { width, height } = getDisplaySize();
    return {
      x: rx * width,
      y: ry * height
    };
  }

  function setTouchMode(disableScroll) {
    if (disableScroll) {
      viewerBody.classList.add("no-scroll");
      pdfStage.classList.add("no-scroll");
      overlayCanvas.classList.add("no-scroll");
      overlayCanvas.style.touchAction = "none";
    } else {
      viewerBody.classList.remove("no-scroll");
      pdfStage.classList.remove("no-scroll");
      overlayCanvas.classList.remove("no-scroll");
      overlayCanvas.style.touchAction = "auto";
    }
  }

  function downloadMeta(doc) {
    const pagesCount = doc.pages ? Object.keys(doc.pages).length : 0;
    return `${formatDate(doc.updatedAt)} ・ ${doc.size.toLocaleString()} bytes ・ ${pagesCount}ページ保存`;
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
    await renderCurrentPage();
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
  // Render PDF page
  // ------------------------------
  async function renderCurrentPage() {
    if (!state.pdfDoc || state.rendering) return;

    state.rendering = true;
    const page = await state.pdfDoc.getPage(state.currentPage);

    const unscaled = page.getViewport({ scale: 1 });
    const containerWidth = Math.max(320, pdfStageWrap.clientWidth - 28);
    const scale = containerWidth / unscaled.width;
    const viewport = page.getViewport({ scale });

    state.currentViewport = viewport;

    pdfCanvas.width = Math.floor(viewport.width);
    pdfCanvas.height = Math.floor(viewport.height);
    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;

    overlayCanvas.width = Math.floor(viewport.width);
    overlayCanvas.height = Math.floor(viewport.height);
    overlayCanvas.style.width = `${viewport.width}px`;
    overlayCanvas.style.height = `${viewport.height}px`;

    pdfStage.style.width = `${viewport.width}px`;
    pdfStage.style.height = `${viewport.height}px`;

    const renderCtx = {
      canvasContext: pdfCtx,
      viewport
    };

    pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    await page.render(renderCtx).promise;

    updateHeader();
    updateGuideLineUI();
    redrawOverlay();

    state.rendering = false;
  }

  function redrawOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const pageState = getCurrentPageState();
    if (!pageState) return;

    // draw masks
    for (const mask of pageState.masks) {
      if (!isMaskVisible(mask, pageState)) continue;
      drawMask(mask, false);
    }

    // draw current draft
    if (state.currentDraft) {
      drawMask(state.currentDraft, true);
    }
  }

  function drawMask(mask, isDraft) {
    overlayCtx.save();
    overlayCtx.fillStyle = "rgba(0,0,0,0.96)";
    overlayCtx.strokeStyle = "rgba(0,0,0,0.96)";
    overlayCtx.lineCap = "round";
    overlayCtx.lineJoin = "round";
    overlayCtx.globalAlpha = isDraft ? 0.88 : 1;

    if (mask.type === "rect") {
      const p = fromRatioPoint(mask.x, mask.y);
      const size = fromRatioPoint(mask.w, mask.h);
      overlayCtx.fillRect(p.x, p.y, size.x, size.y);
    }

    if (mask.type === "line") {
      if (!mask.points || mask.points.length < 2) {
        overlayCtx.restore();
        return;
      }

      const widthPx = (mask.widthRatio || 0.02) * overlayCanvas.width;
      overlayCtx.lineWidth = Math.max(10, widthPx);
      overlayCtx.beginPath();

      const first = fromRatioPoint(mask.points[0].x, mask.points[0].y);
      overlayCtx.moveTo(first.x, first.y);

      for (let i = 1; i < mask.points.length; i++) {
        const p = fromRatioPoint(mask.points[i].x, mask.points[i].y);
        overlayCtx.lineTo(p.x, p.y);
      }
      overlayCtx.stroke();
    }

    overlayCtx.restore();
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

    const pageState = getCurrentPageState();
    const guideMode = pageState?.guidelineMode || "none";
    guideModeLabel.textContent = `基準線:${guideMode}`;
  }

  function updateToolUI() {
    [viewModeBtn, drawLineBtn, drawRectBtn, eraserBtn].forEach((btn) => btn.classList.remove("active"));
    if (state.tool === "view") viewModeBtn.classList.add("active");
    if (state.tool === "line") drawLineBtn.classList.add("active");
    if (state.tool === "rect") drawRectBtn.classList.add("active");
    if (state.tool === "eraser") eraserBtn.classList.add("active");

    const pageState = getCurrentPageState();
    const guideMode = pageState?.guidelineMode || "none";
    guideModeBtn.classList.remove("active", "warn");
    if (guideMode !== "none") {
      guideModeBtn.classList.add("active");
      guideModeBtn.classList.add("warn");
    }

    setTouchMode(state.tool !== "view" || state.dragGuide || state.drawing);
    updateHeader();
  }

  function updateGuideLineUI() {
    const pageState = getCurrentPageState();
    if (!pageState) return;

    const yRatio = clamp(pageState.guidelineY ?? 0.5, 0, 1);
    const yPx = yRatio * overlayCanvas.height;
    guideLine.style.top = `${yPx}px`;

    const guideMode = pageState.guidelineMode || "none";
    guideLine.style.opacity = guideMode === "none" ? "0.55" : "1";
    guideLine.style.borderTopStyle = guideMode === "none" ? "dashed" : "solid";
  }

  function setTool(tool) {
    state.tool = tool;
    state.currentDraft = null;
    state.drawing = false;
    state.dragGuide = false;
    updateToolUI();
    redrawOverlay();
  }

  // ------------------------------
  // Mask creation / hit testing
  // ------------------------------
  function createLineDraft(startX, startY) {
    const p = toRatioPoint(startX, startY);
    return {
      id: generateId("mask"),
      type: "line",
      widthRatio: MASK_LINE_WIDTH / Math.max(overlayCanvas.width, 1),
      userHidden: false,
      points: [p]
    };
  }

  function createRectDraft(startX, startY) {
    const p = toRatioPoint(startX, startY);
    return {
      id: generateId("mask"),
      type: "rect",
      x: p.x,
      y: p.y,
      w: 0,
      h: 0,
      userHidden: false
    };
  }

  function finalizeDraft() {
    const pageState = getCurrentPageState();
    if (!pageState || !state.currentDraft) return;

    const draft = state.currentDraft;

    if (draft.type === "line") {
      if (!draft.points || draft.points.length < 2) {
        state.currentDraft = null;
        redrawOverlay();
        return;
      }
    }

    if (draft.type === "rect") {
      if (Math.abs(draft.w) < 0.002 || Math.abs(draft.h) < 0.002) {
        state.currentDraft = null;
        redrawOverlay();
        return;
      }
      normalizeRectDraft(draft);
    }

    pageState.masks.push(draft);
    state.currentDraft = null;
    redrawOverlay();
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

  function hitTestRect(mask, px, py) {
    const pos = fromRatioPoint(mask.x, mask.y);
    const size = fromRatioPoint(mask.w, mask.h);
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

  function hitTestLine(mask, px, py) {
    if (!mask.points || mask.points.length < 2) return false;
    const widthPx = Math.max(12, (mask.widthRatio || 0.02) * overlayCanvas.width);
    const threshold = widthPx * 0.7 + 8;

    for (let i = 1; i < mask.points.length; i++) {
      const a = fromRatioPoint(mask.points[i - 1].x, mask.points[i - 1].y);
      const b = fromRatioPoint(mask.points[i].x, mask.points[i].y);
      const d = distancePointToSegment(px, py, a.x, a.y, b.x, b.y);
      if (d <= threshold) return true;
    }
    return false;
  }

  function findTopMaskAt(px, py, includeHidden = true) {
    const pageState = getCurrentPageState();
    if (!pageState) return null;

    for (let i = pageState.masks.length - 1; i >= 0; i--) {
      const mask = pageState.masks[i];
      if (!includeHidden && !isMaskVisible(mask, pageState)) continue;

      const hit = mask.type === "rect"
        ? hitTestRect(mask, px, py)
        : hitTestLine(mask, px, py);

      if (hit) return { mask, index: i };
    }
    return null;
  }

  // ------------------------------
  // Guide line
  // ------------------------------
  function isNearGuideLine(py) {
    const pageState = getCurrentPageState();
    if (!pageState) return false;
    const guideY = (pageState.guidelineY ?? 0.5) * overlayCanvas.height;
    return Math.abs(py - guideY) <= GUIDE_HIT_PX;
  }

  async function cycleGuideMode() {
    const pageState = getCurrentPageState();
    if (!pageState) return;

    const current = pageState.guidelineMode || "none";
    const nextIndex = (GUIDE_MODES.indexOf(current) + 1) % GUIDE_MODES.length;
    pageState.guidelineMode = GUIDE_MODES[nextIndex];

    updateGuideLineUI();
    updateToolUI();
    redrawOverlay();
    await persistPageState();
  }

  async function setGuideLineByY(pxY) {
    const pageState = getCurrentPageState();
    if (!pageState) return;
    pageState.guidelineY = clamp(pxY / overlayCanvas.height, 0, 1);
    updateGuideLineUI();
    redrawOverlay();
    await persistPageState();
  }

  // ------------------------------
  // Pointer events
  // ------------------------------
  function onPointerDown(e) {
    if (!state.pdfDoc) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const pos = getPointerPos(e);
    state.activePointerId = e.pointerId;

    if (state.tool === "view") {
      if (isNearGuideLine(pos.y)) {
        state.dragGuide = true;
        setTouchMode(true);
        overlayCanvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }

      const hit = findTopMaskAt(pos.x, pos.y, true);
      if (hit) {
        hit.mask.userHidden = !hit.mask.userHidden;
        redrawOverlay();
        persistPageState();
        e.preventDefault();
      }
      return;
    }

    if (state.tool === "eraser") {
      const hit = findTopMaskAt(pos.x, pos.y, true);
      if (hit) {
        const pageState = getCurrentPageState();
        pageState.masks.splice(hit.index, 1);
        redrawOverlay();
        persistPageState();
      }
      e.preventDefault();
      return;
    }

    if (state.tool === "line" || state.tool === "rect") {
      state.drawing = true;
      state.startX = pos.x;
      state.startY = pos.y;
      state.currentDraft = state.tool === "line"
        ? createLineDraft(pos.x, pos.y)
        : createRectDraft(pos.x, pos.y);

      overlayCanvas.setPointerCapture(e.pointerId);
      setTouchMode(true);
      redrawOverlay();
      e.preventDefault();
    }
  }

  function onPointerMove(e) {
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    const pos = getPointerPos(e);

    if (state.dragGuide) {
      setGuideLineByY(pos.y);
      e.preventDefault();
      return;
    }

    if (!state.drawing || !state.currentDraft) return;

    if (state.currentDraft.type === "line") {
      const p = toRatioPoint(pos.x, pos.y);
      const points = state.currentDraft.points;
      const last = points[points.length - 1];
      const dx = Math.abs((last?.x ?? 0) - p.x);
      const dy = Math.abs((last?.y ?? 0) - p.y);

      // 少し間引いて軽量化
      if (dx + dy > 0.0025) {
        points.push(p);
      }
    }

    if (state.currentDraft.type === "rect") {
      const start = toRatioPoint(state.startX, state.startY);
      const current = toRatioPoint(pos.x, pos.y);
      state.currentDraft.x = start.x;
      state.currentDraft.y = start.y;
      state.currentDraft.w = current.x - start.x;
      state.currentDraft.h = current.y - start.y;
    }

    redrawOverlay();
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;

    if (state.dragGuide) {
      state.dragGuide = false;
      setTouchMode(false);
      persistPageState();
      return;
    }

    if (state.drawing) {
      state.drawing = false;
      finalizeDraft();
      setTouchMode(false);
    }

    state.activePointerId = null;
  }

  function onPointerCancel() {
    state.dragGuide = false;
    state.drawing = false;
    state.currentDraft = null;
    state.activePointerId = null;
    setTouchMode(false);
    redrawOverlay();
  }

  // ------------------------------
  // Page actions
  // ------------------------------
  async function goToPage(pageNum) {
    if (!state.pdfDoc) return;
    const next = clamp(pageNum, 1, state.totalPages);
    if (next === state.currentPage) return;
    state.currentPage = next;
    updateHeader();
    updateGuideLineUI();
    redrawOverlay();
    await persistDocState();
    await renderCurrentPage();
  }

  async function showAllMasks() {
    const pageState = getCurrentPageState();
    if (!pageState) return;
    pageState.masks.forEach((m) => { m.userHidden = false; });
    redrawOverlay();
    await persistPageState();
  }

  async function hideAllMasks() {
    const pageState = getCurrentPageState();
    if (!pageState) return;
    pageState.masks.forEach((m) => { m.userHidden = true; });
    redrawOverlay();
    await persistPageState();
  }

  // ------------------------------
  // Resize
  // ------------------------------
  function handleResize() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (viewerScreen.classList.contains("active") && state.pdfDoc) {
        renderCurrentPage();
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

  guideModeBtn.addEventListener("click", cycleGuideMode);
  showAllBtn.addEventListener("click", showAllMasks);
  hideAllBtn.addEventListener("click", hideAllMasks);

  prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
  nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));

  overlayCanvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  overlayCanvas.addEventListener("pointermove", onPointerMove, { passive: false });
  overlayCanvas.addEventListener("pointerup", onPointerUp, { passive: false });
  overlayCanvas.addEventListener("pointercancel", onPointerCancel, { passive: false });

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
    updateToolUI();
    showHome();
  }

  init();

  // cleanup when page closed
  window.addEventListener("beforeunload", () => {
    cleanupObjectURL();
  });
})();