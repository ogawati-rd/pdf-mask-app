import {
  dbClearAllDocs,
  dbDeleteDoc,
  dbGetAllDocs,
  dbGetDoc,
  dbGetPdfBlob,
  dbPutDoc,
  dbPutPdfBlob
} from "./db.js";
import {
  clamp,
  createEmptyDocState,
  deepClone,
  formatDate,
  formatFileSizeMB,
  generateId,
  makePdfId,
  migrateDocShape,
  nowISO
} from "./utils.js";

const MAX_UNDO = 50;
const PRELOAD_RADIUS = 2;

export async function initApp({ pdfjsLib }) {
  const ctx = {
    pdfjsLib,
    dom: getDomRefs(),
    state: createInitialState()
  };

  bindEvents(ctx);
  await registerSW();
  await renderRecentList(ctx);
  updateBrushUI(ctx);
  updateMarkUI(ctx);
  updateToolUI(ctx);
  showHome(ctx);
}

function getDomRefs() {
  return {
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
}

function createInitialState() {
  return {
    pdfDoc: null,
    pdfLoadingTask: null,
    pdfBlob: null,
    pdfObjectUrl: null,
    currentPdfId: null,
    currentPdfName: "",
    currentPage: 1,
    totalPages: 0,
    mode: "study",
    createTool: "line",
    drawing: false,
    drawingPage: null,
    startX: 0,
    startY: 0,
    activePointerId: null,
    currentDraft: null,
    brushWidth: 18,
    brushColor: "rgba(0,0,0,0.96)",
    activeMarkType: null,
    docState: null,
    pageViews: new Map(),
    pagesContainer: null,
    pageObserver: null,
    undoStack: [],
    scrollRaf: null,
    resizeTimer: null,
    renderQueue: Promise.resolve()
  };
}

function bindEvents(ctx) {
  const { dom, state } = ctx;

  dom.pdfFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleFileSelect(ctx, file);
    dom.pdfFileInput.value = "";
  });

  if (dom.checkUpdateBtn) {
    dom.checkUpdateBtn.addEventListener("click", checkForAppUpdate);
  }

  dom.clearHistoryBtn.addEventListener("click", async () => {
    const ok = confirm("最近開いたPDFの履歴と保存データをすべて削除しますか？");
    if (!ok) return;
    await dbClearAllDocs();
    await renderRecentList(ctx);
  });

  dom.backBtn.addEventListener("click", async () => {
    await persistDocState(state);
    showHome(ctx);
    await renderRecentList(ctx);
  });

  dom.createModeBtn.addEventListener("click", () => setMode(ctx, "create"));
  dom.studyModeBtn.addEventListener("click", () => setMode(ctx, "study"));

  dom.drawLineBtn.addEventListener("click", () => setCreateTool(ctx, "line"));
  dom.drawRectBtn.addEventListener("click", () => setCreateTool(ctx, "rect"));
  dom.eraserBtn.addEventListener("click", () => setCreateTool(ctx, "eraser"));
  dom.undoBtn.addEventListener("click", () => void undoLastAction(ctx));

  dom.showAllBtn.addEventListener("click", () => void showAllMasks(ctx));
  dom.hideAllBtn.addEventListener("click", () => void hideAllMasks(ctx));

  dom.brushSizeInput.addEventListener("input", (event) => {
    state.brushWidth = Number(event.target.value || 18);
    updateBrushUI(ctx);
  });

  dom.colorChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".color-chip");
    if (!chip) return;
    state.brushColor = chip.dataset.color || state.brushColor;
    updateBrushUI(ctx);
  });

  dom.markTypeChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".mark-chip");
    if (!chip) return;
    const next = chip.dataset.mark || null;
    state.activeMarkType = state.activeMarkType === next ? null : next;
    updateMarkUI(ctx);
  });

  dom.viewerBody.addEventListener("scroll", () => onViewerScroll(ctx), { passive: true });
  window.addEventListener("resize", () => handleResize(ctx));
  window.addEventListener("orientationchange", () => handleResize(ctx));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void persistDocState(state);
    }
  });

  window.addEventListener("beforeunload", () => {
    void destroyPdfSession(state);
    cleanupObjectURL(state);
  });
}

function showHome({ dom }) {
  dom.viewerScreen.classList.remove("active");
  dom.homeScreen.classList.add("active");
}

function showViewer({ dom }) {
  dom.homeScreen.classList.remove("active");
  dom.viewerScreen.classList.add("active");
}

function updateHeader({ dom, state }) {
  dom.docTitle.textContent = state.currentPdfName || "-";
  dom.pageInfo.textContent = `${state.currentPage} / ${state.totalPages || 0}`;
}

function updateBrushUI({ dom, state }) {
  dom.brushSizeValue.textContent = String(state.brushWidth);
  dom.colorChips.querySelectorAll(".color-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.color === state.brushColor);
  });
}

function updateMarkUI({ dom, state }) {
  dom.markTypeChips.querySelectorAll(".mark-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.mark === state.activeMarkType);
  });
}

function updateToolUI(ctx) {
  const { dom, state } = ctx;
  dom.drawLineBtn.classList.toggle("active", state.mode === "create" && state.createTool === "line");
  dom.drawRectBtn.classList.toggle("active", state.mode === "create" && state.createTool === "rect");
  dom.eraserBtn.classList.toggle("active", state.mode === "create" && state.createTool === "eraser");
  dom.createTools.classList.toggle("is-hidden", state.mode !== "create");
  dom.studyTools.classList.toggle("is-hidden", state.mode !== "study");
  dom.createModeBtn.classList.toggle("active", state.mode === "create");
  dom.studyModeBtn.classList.toggle("active", state.mode === "study");
  updateHeader(ctx);
  updateBrushUI(ctx);
  updateMarkUI(ctx);
}

function setMode(ctx, mode) {
  const { state } = ctx;
  state.mode = mode;
  state.currentDraft = null;
  state.drawing = false;
  state.drawingPage = null;
  if (mode === "create") {
    state.activeMarkType = null;
  }
  redrawAllDecorations(ctx);
  updateToolUI(ctx);
}

function setCreateTool(ctx, tool) {
  const { state } = ctx;
  state.createTool = tool;
  state.currentDraft = null;
  state.drawing = false;
  state.drawingPage = null;
  redrawAllDecorations(ctx);
  updateToolUI(ctx);
}

async function renderRecentList(ctx) {
  const { dom } = ctx;
  const docs = (await dbGetAllDocs()).map(migrateDocShape).filter(Boolean);
  docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  dom.recentList.innerHTML = "";
  dom.recentEmpty.style.display = docs.length ? "none" : "block";

  docs.forEach((doc) => {
    const item = document.createElement("div");
    item.className = "recent-item";

    const title = document.createElement("div");
    title.className = "recent-title";
    title.textContent = doc.name;

    const meta = document.createElement("div");
    meta.className = "recent-meta";
    meta.textContent = `${formatDate(doc.updatedAt)} ・ ${formatFileSizeMB(doc.size)} ・ ${doc.totalPages || 0}ページ`;

    const actions = document.createElement("div");
    actions.className = "recent-actions";

    const openBtn = document.createElement("button");
    openBtn.className = "recent-open-btn";
    openBtn.type = "button";
    openBtn.textContent = "開く";
    openBtn.addEventListener("click", () => void openSavedPdf(ctx, doc.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "recent-delete-btn";
    deleteBtn.type = "button";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", async () => {
      const ok = confirm(`「${doc.name}」を履歴から削除しますか？`);
      if (!ok) return;
      await dbDeleteDoc(doc.id);
      await renderRecentList(ctx);
    });

    actions.append(openBtn, deleteBtn);
    item.append(title, meta, actions);
    dom.recentList.append(item);
  });
}

async function handleFileSelect(ctx, file) {
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
      lastModified: file.lastModified
    });
  } else {
    existing = migrateDocShape(existing);
    existing.updatedAt = nowISO();
    existing.size = file.size;
    existing.lastModified = file.lastModified;
  }

  await dbPutDoc(existing);
  await dbPutPdfBlob(id, file);
  await openDocState(ctx, existing, file);
  await renderRecentList(ctx);
}

async function openSavedPdf(ctx, id) {
  const doc = await dbGetDoc(id);
  const pdfBlob = await dbGetPdfBlob(id);
  if (!doc || !pdfBlob) {
    alert("保存されたPDFが見つかりませんでした。");
    return;
  }
  await openDocState(ctx, migrateDocShape(doc), pdfBlob);
}

async function openDocState(ctx, doc, pdfBlob) {
  const { state } = ctx;

  await destroyPdfSession(state);
  cleanupObjectURL(state);
  clearPageViews(ctx);
  state.undoStack = [];

  state.docState = migrateDocShape(doc);
  state.currentPdfId = doc.id;
  state.currentPdfName = doc.name;
  state.pdfBlob = pdfBlob;
  state.currentPage = clamp(doc.lastPage || 1, 1, Math.max(doc.totalPages || 1, 1));

  const url = URL.createObjectURL(pdfBlob);
  state.pdfObjectUrl = url;

  try {
    state.pdfLoadingTask = ctx.pdfjsLib.getDocument(url);
    state.pdfDoc = await state.pdfLoadingTask.promise;
  } catch (err) {
    console.error(err);
    alert("PDFの読み込みに失敗しました。");
    return;
  }

  state.totalPages = state.pdfDoc.numPages;
  state.docState.totalPages = state.totalPages;
  if (state.currentPage > state.totalPages) state.currentPage = 1;

  await persistDocState(state);
  showViewer(ctx);
  updateToolUI(ctx);
  await createPageShells(ctx);
  attachPageObserver(ctx);
  renderAroundPage(ctx, state.currentPage);

  requestAnimationFrame(() => {
    scrollToPage(ctx, state.currentPage, false);
    updateCurrentPageFromScroll(ctx);
  });
}

async function createPageShells(ctx) {
  const { dom, state } = ctx;
  const container = document.createElement("div");
  container.className = "pdf-pages-stack";
  state.pagesContainer = container;
  dom.pdfStageWrap.append(container);

  const targetWidth = getTargetPageWidth(dom);

  for (let pageNum = 1; pageNum <= state.totalPages; pageNum += 1) {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const aspectRatio = viewport.height / viewport.width;

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
    container.append(stage);

    const pageView = {
      pageNum,
      stage,
      pdfCanvas,
      overlayCanvas,
      annotationLayer,
      pdfCtx: pdfCanvas.getContext("2d", { alpha: false }),
      overlayCtx: overlayCanvas.getContext("2d"),
      aspectRatio,
      rendered: false,
      rendering: false
    };

    overlayCanvas.addEventListener("pointerdown", (event) => onPointerDown(ctx, event, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointermove", (event) => onPointerMove(ctx, event, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointerup", (event) => onPointerUp(ctx, event, pageNum), { passive: false });
    overlayCanvas.addEventListener("pointercancel", () => onPointerCancel(ctx), { passive: false });

    state.pageViews.set(pageNum, pageView);
    applyPageStageSize(pageView, targetWidth);
  }
}

function attachPageObserver(ctx) {
  const { dom, state } = ctx;
  if (state.pageObserver) {
    state.pageObserver.disconnect();
  }

  state.pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const pageNum = Number(entry.target.dataset.page);
        renderAroundPage(ctx, pageNum);
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

function renderAroundPage(ctx, centerPage) {
  for (let offset = 0; offset <= PRELOAD_RADIUS; offset += 1) {
    const prev = centerPage - offset;
    const next = centerPage + offset;
    if (prev >= 1) queuePageRender(ctx, prev);
    if (next <= ctx.state.totalPages && next !== prev) queuePageRender(ctx, next);
  }
}

function queuePageRender(ctx, pageNum) {
  ctx.state.renderQueue = ctx.state.renderQueue
    .then(() => renderPdfPageIfNeeded(ctx, pageNum))
    .catch((err) => {
      console.error(err);
    });
}

async function renderPdfPageIfNeeded(ctx, pageNum) {
  const { state } = ctx;
  const pageView = getPageView(state, pageNum);
  if (!pageView || pageView.rendered || pageView.rendering || !state.pdfDoc) return;

  pageView.rendering = true;

  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const unscaled = page.getViewport({ scale: 1 });
    const cssWidth = parseFloat(pageView.stage.style.width) || pageView.stage.clientWidth || 320;
    const baseScale = cssWidth / unscaled.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const cssViewport = page.getViewport({ scale: baseScale });
    const renderViewport = page.getViewport({ scale: baseScale * dpr });

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
    redrawPageDecorations(ctx, pageNum);
  } finally {
    pageView.rendering = false;
  }
}

function getTargetPageWidth(dom) {
  return Math.max(320, dom.pdfStageWrap.clientWidth - 28);
}

function applyPageStageSize(pageView, targetWidth) {
  const cssWidth = targetWidth;
  const cssHeight = cssWidth * pageView.aspectRatio;
  pageView.stage.style.width = `${cssWidth}px`;
  pageView.stage.style.height = `${cssHeight}px`;
}

function getPageView(state, pageNum) {
  return state.pageViews.get(pageNum) || null;
}

function clearPageViews({ dom, state }) {
  if (state.pageObserver) {
    state.pageObserver.disconnect();
    state.pageObserver = null;
  }
  state.pageViews.clear();
  state.pagesContainer = null;
  dom.pdfStageWrap.innerHTML = "";
}

async function destroyPdfSession(state) {
  if (state.pdfLoadingTask) {
    try {
      await state.pdfLoadingTask.destroy();
    } catch (err) {
      console.warn("PDF loading task destroy failed:", err);
    }
    state.pdfLoadingTask = null;
  }

  if (state.pdfDoc) {
    try {
      await state.pdfDoc.destroy();
    } catch (err) {
      console.warn("PDF document destroy failed:", err);
    }
    state.pdfDoc = null;
  }
}

function cleanupObjectURL(state) {
  if (state.pdfObjectUrl) {
    URL.revokeObjectURL(state.pdfObjectUrl);
    state.pdfObjectUrl = null;
  }
}

async function persistDocState(state) {
  if (!state.docState) return;
  state.docState.updatedAt = nowISO();
  state.docState.lastPage = state.currentPage;
  state.docState.totalPages = state.totalPages;
  await dbPutDoc(state.docState);
}

function getPageState(state, pageNum) {
  if (!state.docState) return null;
  const key = String(pageNum);
  if (!state.docState.pages[key]) {
    state.docState.pages[key] = { masks: [], annotations: [] };
  } else {
    if (!Array.isArray(state.docState.pages[key].masks)) state.docState.pages[key].masks = [];
    if (!Array.isArray(state.docState.pages[key].annotations)) state.docState.pages[key].annotations = [];
  }
  return state.docState.pages[key];
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

function isMaskVisible(mask) {
  return !mask.userHidden;
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

function drawMask(ctx, overlayCanvas, mask, isDraft) {
  const color = mask.color || "rgba(0,0,0,0.96)";
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

function redrawOverlayForPage(ctx, pageNum) {
  const pageView = getPageView(ctx.state, pageNum);
  const pageState = getPageState(ctx.state, pageNum);
  if (!pageView || !pageState || !pageView.overlayCanvas.width) return;

  const canvasCtx = pageView.overlayCtx;
  canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
  canvasCtx.clearRect(0, 0, pageView.overlayCanvas.width, pageView.overlayCanvas.height);

  for (const mask of pageState.masks) {
    if (!isMaskVisible(mask)) continue;
    drawMask(canvasCtx, pageView.overlayCanvas, mask, false);
  }

  if (ctx.state.currentDraft && ctx.state.drawingPage === pageNum) {
    drawMask(canvasCtx, pageView.overlayCanvas, ctx.state.currentDraft, true);
  }
}

function redrawAnnotationsForPage(ctx, pageNum) {
  const pageView = getPageView(ctx.state, pageNum);
  const pageState = getPageState(ctx.state, pageNum);
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
    pageView.annotationLayer.append(element);
  }
}

function redrawPageDecorations(ctx, pageNum) {
  redrawOverlayForPage(ctx, pageNum);
  redrawAnnotationsForPage(ctx, pageNum);
}

function redrawAllDecorations(ctx) {
  for (let pageNum = 1; pageNum <= ctx.state.totalPages; pageNum += 1) {
    redrawPageDecorations(ctx, pageNum);
  }
}

function pushUndoSnapshot(state, pageNum) {
  const pageState = getPageState(state, pageNum);
  if (!pageState) return;
  state.undoStack.push({
    pageNum,
    pageState: deepClone(pageState)
  });
  if (state.undoStack.length > MAX_UNDO) {
    state.undoStack.shift();
  }
}

async function undoLastAction(ctx) {
  const { state } = ctx;
  if (!state.undoStack.length) return;
  const last = state.undoStack.pop();
  if (!last) return;
  state.docState.pages[String(last.pageNum)] = deepClone(last.pageState);
  redrawPageDecorations(ctx, last.pageNum);
  await persistDocState(state);
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

function findTopMaskAt(ctx, pageNum, px, py) {
  const pageState = getPageState(ctx.state, pageNum);
  const pageView = getPageView(ctx.state, pageNum);
  if (!pageState || !pageView || !pageView.overlayCanvas.width) return null;

  for (let i = pageState.masks.length - 1; i >= 0; i -= 1) {
    const mask = pageState.masks[i];
    const hit = mask.type === "rect"
      ? hitTestRect(mask, px, py, pageView.overlayCanvas)
      : hitTestLine(mask, px, py, pageView.overlayCanvas);

    if (hit) return { mask, index: i };
  }
  return null;
}

function findAnnotationAt(ctx, pageNum, px, py) {
  const pageState = getPageState(ctx.state, pageNum);
  const pageView = getPageView(ctx.state, pageNum);
  if (!pageState || !pageView || !pageView.overlayCanvas.width) return null;

  for (let i = pageState.annotations.length - 1; i >= 0; i -= 1) {
    const ann = pageState.annotations[i];
    if (ann.type !== "mark") continue;
    const point = fromRatioPoint(ann.x, ann.y, pageView.overlayCanvas);
    if (Math.hypot(px - point.x, py - point.y) <= 22) return { ann, index: i };
  }
  return null;
}

function createLineDraft(ctx, startX, startY, overlayCanvas) {
  const point = toRatioPoint(startX, startY, overlayCanvas);
  const metrics = getCanvasMetrics(overlayCanvas);
  return {
    id: generateId("mask"),
    type: "line",
    widthRatio: ctx.state.brushWidth / Math.max(metrics.cssWidth, 1),
    color: ctx.state.brushColor,
    userHidden: false,
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y
  };
}

function createRectDraft(ctx, startX, startY, overlayCanvas) {
  const point = toRatioPoint(startX, startY, overlayCanvas);
  return {
    id: generateId("mask"),
    type: "rect",
    x: point.x,
    y: point.y,
    w: 0,
    h: 0,
    color: ctx.state.brushColor,
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

async function finalizeDraft(ctx, pageNum) {
  const pageState = getPageState(ctx.state, pageNum);
  if (!pageState || !ctx.state.currentDraft) return;

  const draft = ctx.state.currentDraft;

  if (draft.type === "line") {
    const dx = Math.abs((draft.x2 ?? 0) - (draft.x1 ?? 0));
    const dy = Math.abs((draft.y2 ?? 0) - (draft.y1 ?? 0));
    if (dx + dy < 0.002) {
      ctx.state.currentDraft = null;
      redrawOverlayForPage(ctx, pageNum);
      return;
    }
  }

  if (draft.type === "rect") {
    if (Math.abs(draft.w) < 0.002 || Math.abs(draft.h) < 0.002) {
      ctx.state.currentDraft = null;
      redrawOverlayForPage(ctx, pageNum);
      return;
    }
    normalizeRectDraft(draft);
  }

  pushUndoSnapshot(ctx.state, pageNum);
  pageState.masks.push(draft);
  ctx.state.currentDraft = null;
  ctx.state.drawingPage = null;
  redrawOverlayForPage(ctx, pageNum);
  await persistDocState(ctx.state);
}

async function placeOrToggleMark(ctx, pageNum, px, py) {
  const pageState = getPageState(ctx.state, pageNum);
  const pageView = getPageView(ctx.state, pageNum);
  if (!pageState || !pageView || !ctx.state.activeMarkType || ctx.state.activeMarkType === "erase") return;

  const existing = findAnnotationAt(ctx, pageNum, px, py);
  pushUndoSnapshot(ctx.state, pageNum);

  if (existing) {
    pageState.annotations.splice(existing.index, 1);
  } else {
    const point = toRatioPoint(px, py, pageView.overlayCanvas);
    pageState.annotations.push({
      id: generateId("ann"),
      type: "mark",
      kind: ctx.state.activeMarkType,
      x: point.x,
      y: point.y
    });
  }

  redrawAnnotationsForPage(ctx, pageNum);
  await persistDocState(ctx.state);
}

async function eraseMarkAt(ctx, pageNum, px, py) {
  const pageState = getPageState(ctx.state, pageNum);
  if (!pageState) return;
  const existing = findAnnotationAt(ctx, pageNum, px, py);
  if (!existing) return;

  pushUndoSnapshot(ctx.state, pageNum);
  pageState.annotations.splice(existing.index, 1);
  redrawAnnotationsForPage(ctx, pageNum);
  await persistDocState(ctx.state);
}

function isPenEvent(event) {
  return event.pointerType === "pen";
}

function onPointerDown(ctx, event, pageNum) {
  if (!ctx.state.pdfDoc) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const pageView = getPageView(ctx.state, pageNum);
  if (!pageView || !pageView.overlayCanvas.width) return;

  const pos = getPointerPos(event, pageView.overlayCanvas);
  ctx.state.activePointerId = event.pointerId;

  if (ctx.state.mode === "study") {
    if (ctx.state.activeMarkType === "erase") {
      void eraseMarkAt(ctx, pageNum, pos.x, pos.y);
      event.preventDefault();
      return;
    }

    if (ctx.state.activeMarkType) {
      void placeOrToggleMark(ctx, pageNum, pos.x, pos.y);
      event.preventDefault();
      return;
    }

    const hit = findTopMaskAt(ctx, pageNum, pos.x, pos.y);
    if (hit) {
      hit.mask.userHidden = !hit.mask.userHidden;
      redrawOverlayForPage(ctx, pageNum);
      void persistDocState(ctx.state);
      event.preventDefault();
    }
    return;
  }

  if (!isPenEvent(event)) return;

  if (ctx.state.createTool === "eraser") {
    const hit = findTopMaskAt(ctx, pageNum, pos.x, pos.y);
    if (hit) {
      pushUndoSnapshot(ctx.state, pageNum);
      const pageState = getPageState(ctx.state, pageNum);
      pageState.masks.splice(hit.index, 1);
      redrawOverlayForPage(ctx, pageNum);
      void persistDocState(ctx.state);
    }
    event.preventDefault();
    return;
  }

  ctx.state.drawing = true;
  ctx.state.drawingPage = pageNum;
  ctx.state.startX = pos.x;
  ctx.state.startY = pos.y;
  ctx.state.currentDraft = ctx.state.createTool === "line"
    ? createLineDraft(ctx, pos.x, pos.y, pageView.overlayCanvas)
    : createRectDraft(ctx, pos.x, pos.y, pageView.overlayCanvas);

  pageView.overlayCanvas.setPointerCapture(event.pointerId);
  ctx.dom.viewerBody.classList.add("no-scroll");
  redrawOverlayForPage(ctx, pageNum);
  event.preventDefault();
}

function onPointerMove(ctx, event, pageNum) {
  if (ctx.state.activePointerId !== null && event.pointerId !== ctx.state.activePointerId) return;
  if (!ctx.state.drawing || !ctx.state.currentDraft || !isPenEvent(event)) return;
  if (ctx.state.drawingPage !== pageNum) return;

  const pageView = getPageView(ctx.state, pageNum);
  if (!pageView || !pageView.overlayCanvas.width) return;
  const pos = getPointerPos(event, pageView.overlayCanvas);

  if (ctx.state.currentDraft.type === "line") {
    const point = toRatioPoint(pos.x, pos.y, pageView.overlayCanvas);
    ctx.state.currentDraft.x2 = point.x;
    ctx.state.currentDraft.y2 = point.y;
  } else {
    const start = toRatioPoint(ctx.state.startX, ctx.state.startY, pageView.overlayCanvas);
    const current = toRatioPoint(pos.x, pos.y, pageView.overlayCanvas);
    ctx.state.currentDraft.x = start.x;
    ctx.state.currentDraft.y = start.y;
    ctx.state.currentDraft.w = current.x - start.x;
    ctx.state.currentDraft.h = current.y - start.y;
  }

  redrawOverlayForPage(ctx, pageNum);
  event.preventDefault();
}

function onPointerUp(ctx, event, pageNum) {
  if (ctx.state.activePointerId !== null && event.pointerId !== ctx.state.activePointerId) return;

  if (ctx.state.drawing && ctx.state.drawingPage === pageNum) {
    ctx.state.drawing = false;
    void finalizeDraft(ctx, pageNum);
    ctx.dom.viewerBody.classList.remove("no-scroll");
  }

  ctx.state.activePointerId = null;
}

function onPointerCancel(ctx) {
  ctx.state.drawing = false;
  ctx.state.currentDraft = null;
  ctx.state.activePointerId = null;
  ctx.state.drawingPage = null;
  ctx.dom.viewerBody.classList.remove("no-scroll");
  redrawAllDecorations(ctx);
}

function scrollToPage(ctx, pageNum, smooth = true) {
  const pageView = getPageView(ctx.state, pageNum);
  if (!pageView) return;
  pageView.stage.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "start"
  });
}

function updateCurrentPageFromScroll(ctx) {
  const { state, dom } = ctx;
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
    updateHeader(ctx);
    void persistDocState(state);
    renderAroundPage(ctx, bestPage);
  }
}

function onViewerScroll(ctx) {
  if (ctx.state.scrollRaf) cancelAnimationFrame(ctx.state.scrollRaf);
  ctx.state.scrollRaf = requestAnimationFrame(() => {
    updateCurrentPageFromScroll(ctx);
  });
}

async function showAllMasks(ctx) {
  for (let pageNum = 1; pageNum <= ctx.state.totalPages; pageNum += 1) {
    const pageState = getPageState(ctx.state, pageNum);
    if (!pageState) continue;
    pageState.masks.forEach((mask) => {
      mask.userHidden = true;
    });
    redrawOverlayForPage(ctx, pageNum);
  }
  await persistDocState(ctx.state);
}

async function hideAllMasks(ctx) {
  for (let pageNum = 1; pageNum <= ctx.state.totalPages; pageNum += 1) {
    const pageState = getPageState(ctx.state, pageNum);
    if (!pageState) continue;
    pageState.masks.forEach((mask) => {
      mask.userHidden = false;
    });
    redrawOverlayForPage(ctx, pageNum);
  }
  await persistDocState(ctx.state);
}

function handleResize(ctx) {
  clearTimeout(ctx.state.resizeTimer);
  ctx.state.resizeTimer = setTimeout(() => {
    if (!ctx.dom.viewerScreen.classList.contains("active") || !ctx.state.pdfDoc) return;

    const targetWidth = getTargetPageWidth(ctx.dom);
    ctx.state.pageViews.forEach((pageView) => {
      applyPageStageSize(pageView, targetWidth);
      pageView.rendered = false;
      pageView.rendering = false;
      pageView.pdfCanvas.width = 0;
      pageView.pdfCanvas.height = 0;
      pageView.overlayCanvas.width = 0;
      pageView.overlayCanvas.height = 0;
      pageView.annotationLayer.innerHTML = "";
    });

    renderAroundPage(ctx, ctx.state.currentPage);
    scrollToPage(ctx, ctx.state.currentPage, false);
    updateCurrentPageFromScroll(ctx);
  }, 120);
}

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
