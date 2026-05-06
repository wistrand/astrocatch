// 3x3 random Nebula inspector. No background, no labels,
// no input — just a static grid of nine differently-seeded
// Nebulae for visual review of the procedural shader.

import { createRenderer } from "./renderer.js";
import { PALETTE_LEN } from "./star-rendering.js";

const canvas = document.getElementById("c");
let W = 0, H = 0, DPR = 1;
let renderer = null;
let stars = null;
const ZMIN = 0.1, ZMAX = 12.0;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  if (renderer) renderer.setViewport(W, H, DPR);
}
window.addEventListener("resize", resize);
resize();
renderer = createRenderer(canvas);
if (!renderer) {
  document.body.innerHTML =
    "<p style='padding:20px;color:#fff'>WebGL2 required.</p>";
  throw new Error("no webgl2");
}
renderer.setViewport(W, H, DPR);

function makeNebula(x, y, r, colorIdx, seed) {
  return {
    x, y, r,
    colorIdx,
    seed,
    caught: false,
    pulse: 0,
    hasRays: false,
    nGran: 6,
    isBlackHole: false,
    isBinary: false,
    binary: null,
    isMonolith: false,
    isPulsar: false,
    isRingworld: false,
    ringPlateCount: 0,
    isNebula: true,
  };
}

// URL param ?seed=<float> drives the base seed for the whole grid.
// If absent, we pick a random seed and write it back to the URL via
// history.replaceState so the bar always shows the current seed.
// Each cell derives its own per-nebula seed from base + cellIndex *
// stride; the renderer then feeds that into v_seed and every per-
// nebula categorical/continuous axis (palette, bipolar amp, cavity
// size, fibre params, central flavour, pulsar offset, morphCat...)
// reads from that single number. Same seed → identical nebula grid.
const urlParams = new URLSearchParams(window.location.search);
const seedParam = urlParams.get("seed");
const baseSeed = seedParam !== null && !Number.isNaN(parseFloat(seedParam))
  ? parseFloat(seedParam)
  : Math.random() * 1000;
if (seedParam === null) {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", baseSeed.toFixed(4));
  window.history.replaceState(null, "", url.toString());
}
function hash01(s) {
  // sin-based hash → [0, 1). Stable per integer input given fixed
  // float math; only used to derive deterministic per-cell colour
  // index from the base seed.
  return ((Math.sin(s * 12.9898) * 43758.5453) % 1 + 1) % 1;
}

// URL param ?grid=N (square N×N) or ?grid=CxR (cols × rows).
// Defaults to 3×3. Clamped to [1, 20] per axis to avoid pathological
// canvases of 1000+ nebulae.
const gridParam = urlParams.get("grid");
let gridCols = 3, gridRows = 3;
if (gridParam) {
  if (gridParam.includes("x")) {
    const parts = gridParam.split("x");
    gridCols = Math.max(1, Math.min(20, parseInt(parts[0], 10) || 3));
    gridRows = Math.max(1, Math.min(20, parseInt(parts[1], 10) || 3));
  } else {
    const n = Math.max(1, Math.min(20, parseInt(gridParam, 10) || 3));
    gridCols = n;
    gridRows = n;
  }
}

const SPACING_X = 380;
const SPACING_Y = 380;
const CELL_R = 36;
stars = [];
let cellIdx = 0;
for (let row = 0; row < gridRows; row++) {
  for (let col = 0; col < gridCols; col++) {
    const x = col * SPACING_X;
    const y = row * SPACING_Y;
    // Per-cell seed striding so cells get distinctly different
    // categorical bins. 7.13 stride was picked so adjacent cells
    // routinely pick different palettes / morph cats.
    const cellSeed = baseSeed + cellIdx * 7.13;
    const colorIdx = Math.floor(hash01(cellSeed * 31.0) * PALETTE_LEN);
    stars.push(makeNebula(x, y, CELL_R, colorIdx, cellSeed));
    cellIdx++;
  }
}

let camX = 0, camY = 0, zoom = 0.55;
function fitView() {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const s of stars) {
    const margin = s.r * 4 + 40;
    if (s.x - margin < minX) minX = s.x - margin;
    if (s.x + margin > maxX) maxX = s.x + margin;
    if (s.y - margin < minY) minY = s.y - margin;
    if (s.y + margin > maxY) maxY = s.y + margin;
  }
  const wWorld = maxX - minX;
  const hWorld = maxY - minY;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  camX = -cx;
  camY = -cy;
  zoom = 0.92 * Math.min(W / wWorld, H / hWorld);
  zoom = Math.max(ZMIN, Math.min(ZMAX, zoom));
}
fitView();
window.addEventListener("resize", () => { fitView(); });

// ─── Pan + pinch-zoom (ported from debug.js) ──────────────
//   1 pointer (mouse drag or single touch): pan
//   2 touches: pinch to zoom toward the midpoint
//   wheel: zoom toward cursor
//   '0' key: reset view
const activePointers = new Map();
let lastPinchDist = 0;
let lastPinchMid = null;
function zoomToward(sx, sy, newZoom) {
  newZoom = Math.max(ZMIN, Math.min(ZMAX, newZoom));
  const wxBefore = (sx - W / 2) / zoom - camX;
  const wyBefore = (sy - H / 2) / zoom - camY;
  zoom = newZoom;
  const wxAfter = (sx - W / 2) / zoom - camX;
  const wyAfter = (sy - H / 2) / zoom - camY;
  camX += wxAfter - wxBefore;
  camY += wyAfter - wyBefore;
}
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastPinchDist = 0;
  lastPinchMid = null;
});
canvas.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  const prev = activePointers.get(e.pointerId);
  const dx = e.clientX - prev.x;
  const dy = e.clientY - prev.y;
  prev.x = e.clientX;
  prev.y = e.clientY;
  if (activePointers.size === 1) {
    camX += dx / zoom;
    camY += dy / zoom;
  } else if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const midX = (pts[0].x + pts[1].x) * 0.5;
    const midY = (pts[0].y + pts[1].y) * 0.5;
    if (lastPinchDist > 0 && lastPinchMid) {
      const wx = (lastPinchMid.x - W / 2) / zoom - camX;
      const wy = (lastPinchMid.y - H / 2) / zoom - camY;
      zoom = Math.max(ZMIN, Math.min(ZMAX, zoom * (dist / lastPinchDist)));
      camX = (midX - W / 2) / zoom - wx;
      camY = (midY - H / 2) / zoom - wy;
    }
    lastPinchDist = dist;
    lastPinchMid = { x: midX, y: midY };
  }
});
function endPointer(e) {
  activePointers.delete(e.pointerId);
  lastPinchDist = 0;
  lastPinchMid = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomToward(e.clientX, e.clientY, zoom * factor);
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.key === "0") fitView();
});

const TIME_WRAP = Math.PI * 2 * 10000;
function loop(t) {
  const tSec = (t / 1000) % TIME_WRAP;

  renderer.beginFrame(tSec, false);
  // No drawBackground, no drawBgStars — empty void only.

  const cam = renderer.replayMat(zoom, W / 2 + camX * zoom, H / 2 + camY * zoom);

  const starBatch = [];
  for (const s of stars) {
    starBatch.push({
      x: s.x, y: s.y, r: s.r,
      colorIdx: s.colorIdx,
      seed: s.seed,
      pulse: 0,
      wobble: 0, wobbleAngle: 0,
      hasRays: false, nGran: 6,
      isCurrent: false, isNext: false, isPast: false,
      isBlackHole: false,
      isMonolith: false,
      isRingworld: false,
      ringPlateCount: 0,
      isPulsar: false,
      isNebula: true,
    });
  }
  renderer.drawStarBatch(starBatch, cam);
  renderer.finalizeFrame([]);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
