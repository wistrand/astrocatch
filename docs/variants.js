// Variant inspector. Renders a deterministic grid of one star type with per-cell variations for
// visual review of the procedural shader. URL params:
//
// ?type=<name> which variant to render. Default: nebula. Recognised: plain, binary, bh, bhBinary,
// monolith, ringworld, pulsar, nebula, teapot. ?seed=<float> base seed for the whole grid. Each
// cell derives its own seed by stride. Page writes its random pick back to the URL on first load so
// the bar always shows the seed. ?grid=N or ?grid=CxR grid size; clamped to [1, 20] per axis.
// Default: 3x3.
//
// Backward compatibility: with no `type=`, behaves identically to the previous nebula-only
// inspector.

import { createRenderer } from "./renderer.js";
import { createRenderer2D } from "./renderer-2d.js";
import {
  PALETTE_LEN, assignBinary, binaryPositions,
} from "./star-rendering.js";
import { starGM } from "./physics.js";

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
// ?vector=1 forces the Tier-1 Canvas2D rendition. Variants all draw as plain colour-tinted
// disks under this mode, so the grid is mostly useful for confirming the low-fi path still
// draws cleanly across types rather than for variant detail review.
const _useVector = new URLSearchParams(location.search).get("vector") === "1";
renderer = _useVector ? createRenderer2D(canvas) : createRenderer(canvas);
if (!renderer) {
  document.body.innerHTML =
    "<p style='padding:20px;color:#fff'>WebGL2 required.</p>";
  throw new Error("no webgl2");
}
renderer.setViewport(W, H, DPR);

const urlParams = new URLSearchParams(window.location.search);

// ─── Type registry ────────────────────────────────────────
// Each entry mutates a base star to express the variant. `apply(s, seed)` runs after the star is
// constructed; it can flip flags, attach a `binary`, set `ringPlateCount`, etc. `seed` is the
// per-cell seed (handy for any deterministic internal variation we want to drive — e.g.
// ringPlateCount).
function hash01(s) {
  return ((Math.sin(s * 12.9898) * 43758.5453) % 1 + 1) % 1;
}
// rMin / rMax bracket the per-cell size range. Heavy variants (pulsar, nebula, teapot) use higher
// floors because the gameplay's minR rules make their visuals depend on adequate size; smaller
// floors here would just produce illegible cells.
const TYPE_REGISTRY = {
  plain:     { apply: () => {},                                rMin: 22, rMax: 52 },
  binary:    { apply: (s) => assignBinary(s),                  rMin: 28, rMax: 56 },
  bh:        { apply: (s) => { s.isBlackHole = true; },        rMin: 24, rMax: 52 },
  bhBinary:  { apply: (s) => { s.isBlackHole = true; assignBinary(s); }, rMin: 28, rMax: 56 },
  monolith:  { apply: (s) => { s.isMonolith = true; },         rMin: 22, rMax: 50 },
  ringworld: { apply: (s, seed) => {
                 s.isRingworld = true;
                 s.ringPlateCount = Math.floor(hash01(seed * 17.3) * 8);
               },                                              rMin: 24, rMax: 50 },
  pulsar:    { apply: (s) => { s.isPulsar = true; },           rMin: 30, rMax: 54 },
  nebula:    { apply: (s) => { s.isNebula = true; },           rMin: 30, rMax: 56 },
  teapot:    { apply: (s) => { s.isTeapot = true; },           rMin: 40, rMax: 64 },
  azazel:    { apply: (s) => { s.isAzazel = true; },           rMin: 40, rMax: 64 },
};
const TYPE = (urlParams.get("type") || "nebula").toLowerCase();
const cfg = TYPE_REGISTRY[TYPE] || TYPE_REGISTRY.nebula;
const RESOLVED_TYPE = TYPE_REGISTRY[TYPE] ? TYPE : "nebula";
document.title = `ASTROCATCH — ${RESOLVED_TYPE} inspector`;

// Base seed: random if absent, written back to the URL bar so reloading without changing the URL
// keeps the same grid.
const seedParam = urlParams.get("seed");
const baseSeed = seedParam !== null && !Number.isNaN(parseFloat(seedParam))
  ? parseFloat(seedParam)
  : Math.random() * 1000;
if (seedParam === null) {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", baseSeed.toFixed(4));
  window.history.replaceState(null, "", url.toString());
}

// Grid size: ?grid=N (square) or ?grid=CxR. Clamped to [1, 20].
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
function makeStar(x, y, r, colorIdx, seed) {
  const s = {
    x, y, r,
    gm: starGM(r),
    colorIdx,
    seed,
    caught: false,
    pulse: 0,
    hasRays: true,
    nGran: 6,
    planets: null,
    comets: null,
    isBlackHole: false,
    isBinary: false,
    binary: null,
    isMonolith: false,
    isPulsar: false,
    isRingworld: false,
    ringPlateCount: 0,
    isNebula: false,
    isTeapot: false,
    isAzazel: false,
  };
  cfg.apply(s, seed);
  // Nebula doesn't want diffraction rays from the central pinpoint;
  // teapot/monolith/ringworld/azazel replace the body entirely so rays are irrelevant.
  if (s.isNebula || s.isMonolith || s.isRingworld
      || s.isTeapot || s.isAzazel) {
    s.hasRays = false;
  }
  return s;
}

stars = [];
let cellIdx = 0;
for (let row = 0; row < gridRows; row++) {
  for (let col = 0; col < gridCols; col++) {
    const x = col * SPACING_X;
    const y = row * SPACING_Y;
    const cellSeed = baseSeed + cellIdx * 7.13;
    const colorIdx = Math.floor(hash01(cellSeed * 31.0) * PALETTE_LEN);
    // Independent hash for size so colour and size vary independently rather than co-correlating
    // with the seed.
    const tR = hash01(cellSeed * 5.7);
    const r = cfg.rMin + (cfg.rMax - cfg.rMin) * tR;
    stars.push(makeStar(x, y, r, colorIdx, cellSeed));
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
// 1 pointer (mouse drag or single touch): pan 2 touches: pinch to zoom toward the midpoint wheel:
// zoom toward cursor '0' key: reset view
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
// Rolling-mean FPS counter — same window/cadence as the in-game one. Always-on in the inspector
// since this page is purely a perf/visual reference.
const FPS_WINDOW_MS = 3000;
const fpsEl = document.getElementById("fps");
const fpsSamples = [];
let fpsWindowMs = 0;
let fpsLastDisplayMs = 0;
let lastFrameMs = -1;
let frame = 0;
function loop(t) {
  const tSec = (t / 1000) % TIME_WRAP;

  renderer.beginFrame(tSec, false);
  renderer.drawBackground(0);
  renderer.drawBgStars();

  const cam = renderer.replayMat(zoom, W / 2 + camX * zoom, H / 2 + camY * zoom);

  const starBatch = [];
  for (const s of stars) {
    if (s.isBinary && s.binary) {
      const subs = binaryPositions(s, frame);
      const b = s.binary;
      const orbAngle = frame * b.omega + b.phase;
      for (let j = 0; j < 2; j++) {
        const subBH = j === 1 && b.accretorIsBH;
        const tidalSeed = (orbAngle + j * Math.PI - tSec) % TIME_WRAP;
        starBatch.push({
          x: subs[j].x, y: subs[j].y,
          r: subBH ? subs[j].r * 0.5 : subs[j].r,
          colorIdx: j === 0 ? b.colorIdx1 : b.colorIdx2,
          seed: tidalSeed,
          pulse: 0,
          wobble: 0, wobbleAngle: 0,
          hasRays: s.hasRays, nGran: s.nGran,
          isCurrent: false, isNext: false, isPast: false,
          isBlackHole: subBH,
        });
      }
    } else {
      starBatch.push({
        x: s.x, y: s.y,
        r: s.isBlackHole ? s.r * 0.5 : s.r,
        colorIdx: s.colorIdx,
        seed: s.seed,
        pulse: 0,
        wobble: 0, wobbleAngle: 0,
        hasRays: s.hasRays, nGran: s.nGran,
        isCurrent: false, isNext: false, isPast: false,
        isBlackHole: s.isBlackHole,
        isMonolith: s.isMonolith,
        isRingworld: s.isRingworld,
        ringPlateCount: s.ringPlateCount | 0,
        isPulsar: s.isPulsar,
        isNebula: s.isNebula,
        isTeapot: s.isTeapot,
        isAzazel: s.isAzazel,
      });
    }
  }
  renderer.drawStarBatch(starBatch, cam);
  renderer.finalizeFrame([]);

  frame++;
  // Rolling-mean FPS — push current frame's elapsed onto the queue, drop anything older than the
  // window, refresh the readout at most every 250 ms.
  if (lastFrameMs >= 0) {
    let elapsed = t - lastFrameMs;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > 250) elapsed = 250; // clamp big tab-switch gaps
    fpsSamples.push(elapsed);
    fpsWindowMs += elapsed;
    while (fpsWindowMs > FPS_WINDOW_MS && fpsSamples.length > 1) {
      fpsWindowMs -= fpsSamples.shift();
    }
    fpsLastDisplayMs += elapsed;
    if (fpsLastDisplayMs >= 250 && fpsWindowMs > 0) {
      const mean = (fpsSamples.length * 1000) / fpsWindowMs;
      fpsEl.textContent = mean.toFixed(1) + " fps";
      fpsLastDisplayMs = 0;
    }
  }
  lastFrameMs = t;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
