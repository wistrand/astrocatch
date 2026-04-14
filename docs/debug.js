// Variant inspector — renders one example of each star-spawn
// type in a static grid for visual reference. No physics, no
// audio, no input beyond pan/zoom on the canvas. Useful for
// regression testing shader changes and for seeing all
// variants side by side without playing through random spawns.

import * as AC from "./physics.js";
import { createRenderer, c1Of } from "./renderer.js";
import {
  PALETTE_LEN,
  binaryPositions,
  assignBinary,
  updateEjecta,
  appendCometBatch,
  cometPosition,
} from "./star-rendering.js";

const canvas = document.getElementById("c");
const labelsEl = document.getElementById("labels");
let W = 0, H = 0, DPR = 1;
let renderer = null;
// Declared early so resize()'s layoutLabels() call doesn't
// hit a TDZ on initial module load.
const labelDoms = [];
let stars = null;
// Wake particles (outgassing trail) for active comets.
const particles = [];
// Zoom limits — referenced by fitView(), which runs at load
// time before the input handlers are wired up.
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
  if (typeof layoutLabels === "function") layoutLabels();
}
window.addEventListener("resize", resize);
resize();
renderer = createRenderer(canvas);
if (!renderer) {
  document.body.innerHTML =
    "<p style='padding:20px'>WebGL2 required.</p>";
  throw new Error("no webgl2");
}
renderer.setViewport(W, H, DPR);

// ─── Build one star per variant ────────────────────────────
function makeBaseStar(x, y, r, colorIdx) {
  return {
    x, y, r,
    gm: AC.starGM(r),
    colorIdx,
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
  };
}

function addPlanets(s) {
  s.planets = [
    {
      orbitR: s.r * 2.0,
      omega: 0.005,
      phase: 0,
      radius: 4,
      colorIdx: 4,
      gm: s.gm * 0.015,
      softR2: 64,
    },
    {
      orbitR: s.r * 2.6,
      omega: -0.004,
      phase: Math.PI,
      radius: 5,
      colorIdx: 2,
      gm: s.gm * 0.015,
      softR2: 100,
    },
  ];
}

function addComet(s) {
  // Field names match the gameplay's comet schema so
  // appendCometBatch / cometPosition work unchanged.
  s.comets = [{
    a: s.r * 4,
    e: 0.85,
    omega: Math.PI * 0.3,
    meanMotion: 2 * Math.PI / 1200,
    phase: 0,
    radius: 4,
    numSyndynes: 3,
  }];
}

const SPACING_X = 380;
const SPACING_Y = 380;
const CELL_R = 36;
function cell(col, row, label, build) {
  const x = col * SPACING_X;
  const y = row * SPACING_Y;
  const s = makeBaseStar(x, y, CELL_R, col % PALETTE_LEN);
  build(s);
  s.world_label = label;
  s.world_label_x = x;
  s.world_label_y = y - CELL_R * 1.8;
  return s;
}

stars = [
  cell(0, 0, "plain", () => {}),
  cell(1, 0, "plain + planets", (s) => addPlanets(s)),
  cell(2, 0, "plain + comet", (s) => addComet(s)),

  cell(0, 1, "binary", (s) => assignBinary(s)),
  cell(1, 1, "bh solo", (s) => { s.isBlackHole = true; }),
  cell(2, 1, "bh + binary", (s) => {
    s.isBlackHole = true;
    assignBinary(s);
  }),

  cell(0, 2, "monolith", (s) => { s.isMonolith = true; }),
  cell(1, 2, "binary + comet", (s) => {
    assignBinary(s);
    addComet(s);
  }),
  cell(2, 2, "bh + comet", (s) => {
    s.isBlackHole = true;
    addComet(s);
  }),
  cell(0, 3, "ringworld", (s) => { s.isRingworld = true; }),
];

// ─── Labels (DOM overlay positioned via world→screen each frame) ──
function layoutLabels() {
  // Rebuild on resize. Skipped on initial pre-stars load.
  if (!stars) return;
  labelsEl.innerHTML = "";
  labelDoms.length = 0;
  for (const s of stars) {
    const div = document.createElement("div");
    div.className = "label";
    div.textContent = s.world_label;
    labelsEl.appendChild(div);
    labelDoms.push({ div, star: s });
  }
}
layoutLabels();

// ─── Camera (pan + zoom) ───────────────────────────────────
let camX = 0, camY = 0;     // world translation
let zoom = 0.55;
function fitView() {
  if (!stars || stars.length === 0) return;
  // Compute world bounds covering all stars + a margin for
  // labels and corona / lensing extent.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const s of stars) {
    const margin = s.r * 4 + 40; // corona + label space
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
  // Pick the larger zoom-out factor so both axes fit, with a
  // small breathing-room reduction.
  zoom = 0.92 * Math.min(W / wWorld, H / hWorld);
  zoom = Math.max(ZMIN, Math.min(ZMAX, zoom));
}
fitView();
// Also re-fit on resize.
window.addEventListener("resize", () => { fitView(); });

// Pan + pinch-zoom.
//   1 touch (or mouse drag): pan
//   2 touches: pinch to zoom toward the midpoint
// Wheel: zoom toward the cursor.
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
  // Reset pinch baseline whenever the pointer count changes.
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
    // Single-pointer pan.
    camX += dx / zoom;
    camY += dy / zoom;
  } else if (activePointers.size === 2) {
    // Two-pointer pinch + pan. Anchor the world point that was
    // under the previous midpoint so it follows the current
    // midpoint exactly — gives the natural "the world stays
    // glued to your fingers" feel. Single derivation, no
    // double-correction.
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const midX = (pts[0].x + pts[1].x) * 0.5;
    const midY = (pts[0].y + pts[1].y) * 0.5;
    if (lastPinchDist > 0 && lastPinchMid) {
      // World point under the previous midpoint, before zoom.
      const wx = (lastPinchMid.x - W / 2) / zoom - camX;
      const wy = (lastPinchMid.y - H / 2) / zoom - camY;
      // Apply the zoom change.
      zoom = Math.max(ZMIN, Math.min(ZMAX, zoom * (dist / lastPinchDist)));
      // Position camera so (wx, wy) lands under the new midpoint.
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

// Wheel zoom centered on the cursor.
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomToward(e.clientX, e.clientY, zoom * factor);
}, { passive: false });

// '0' resets view.
window.addEventListener("keydown", (e) => {
  if (e.key === "0") fitView();
});

// ─── Render loop ───────────────────────────────────────────
let frame = 0;
function loop(t) {
  const tSec = t / 1000;
  frame++;

  // Detect any visible BH for the conditional FBO.
  let hasBH = false;
  for (const s of stars) {
    if (s.isBlackHole || (s.isBinary && s.binary && s.binary.accretorIsBH)) {
      hasBH = true; break;
    }
  }

  renderer.beginFrame(tSec, hasBH);
  renderer.drawBackground(0);
  renderer.drawBgStars();

  // Camera matrix: bounds-fit form (world → screen with zoom + pan).
  // screen = world * zoom + (W/2 + camX*zoom, H/2 + camY*zoom)
  const cam = renderer.replayMat(zoom, W / 2 + camX * zoom, H / 2 + camY * zoom);

  // Update ejecta if any BH binaries.
  updateEjecta(stars, frame);

  // ─ Star batch ───────────────────────────────────────────
  const starBatch = [];
  const orbAngleSeed = frame;
  for (const s of stars) {
    if (s.isBinary && s.binary) {
      const subs = binaryPositions(s, frame);
      const b = s.binary;
      const orbAngle = frame * b.omega + b.phase;
      for (let j = 0; j < 2; j++) {
        const subBH = j === 1 && b.accretorIsBH;
        const tidalSeed = orbAngle + j * Math.PI - tSec;
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
        colorIdx: s.colorIdx, pulse: 0,
        wobble: 0, wobbleAngle: 0,
        hasRays: s.hasRays, nGran: s.nGran,
        isCurrent: false, isNext: false, isPast: false,
        isBlackHole: s.isBlackHole,
        isMonolith: s.isMonolith,
        isRingworld: s.isRingworld,
      });
    }
  }
  renderer.drawStarBatch(starBatch, cam);

  // ─ Planet circles ───────────────────────────────────────
  const planetBatch = [];
  for (const s of stars) {
    if (!s.planets) continue;
    for (const p of s.planets) {
      const a = frame * p.omega + p.phase;
      const px = s.x + Math.cos(a) * p.orbitR;
      const py = s.y + Math.sin(a) * p.orbitR;
      const c = c1Of(p.colorIdx);
      // Glow halo
      planetBatch.push({
        x: px, y: py,
        outerR: p.radius * 3, innerR: 0,
        r: c[0]*0.3, g: c[1]*0.3, b: c[2]*0.3, a: 0.3,
        kind: 2,
      });
      // Solid core
      planetBatch.push({
        x: px, y: py,
        outerR: p.radius, innerR: 0,
        r: c[0], g: c[1], b: c[2], a: 1,
        kind: 0,
      });
    }
  }
  if (planetBatch.length) renderer.drawCircleBatch(planetBatch, cam);

  // ─ Comets (full multi-syndyne tail + coma + core) ──────
  const cometBatch = [];
  for (const s of stars) {
    if (!s.comets) continue;
    const sc = c1Of(s.colorIdx);
    for (const c of s.comets) {
      const pos = appendCometBatch(s, c, frame, cometBatch);
      // Outgassing wake — same logic as gameplay.js, gated on
      // periapsis activity. Particles drift anti-sunward.
      const periD = c.a * (1 - c.e);
      const apoD = c.a * (1 + c.e);
      const activity = Math.max(0, 1 - (pos.r - periD) / (apoD - periD));
      if (activity > 0.4) {
        const spawnChance = activity * 1.5;
        if (Math.random() < spawnChance) {
          const rdx = pos.x - s.x, rdy = pos.y - s.y;
          const rd = Math.hypot(rdx, rdy) || 1;
          particles.push({
            x: pos.x + (Math.random() - 0.5) * c.radius * 3,
            y: pos.y + (Math.random() - 0.5) * c.radius * 3,
            vx: (Math.random() - 0.5) * 0.3 + (rdx / rd) * 0.5,
            vy: (Math.random() - 0.5) * 0.3 + (rdy / rd) * 0.5,
            life: 1, decay: 0.008 + Math.random() * 0.007,
            r: sc[0] * 0.7, g: sc[1] * 0.7, b: sc[2] * 0.7,
            size: 1 + Math.random() * 1.5,
          });
        }
      }
    }
  }
  if (cometBatch.length) renderer.drawCircleBatch(cometBatch, cam);

  // ─ Particle update + render (comet wake) ────────────────
  // Same settings as gameplay's particle render.
  const partBatch = [];
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.97; p.vy *= 0.97;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    partBatch.push({
      x: p.x, y: p.y,
      outerR: Math.max(0.5, p.size * p.life),
      innerR: 0,
      r: p.r, g: p.g, b: p.b, a: p.life,
      kind: 0,
    });
  }
  if (partBatch.length) renderer.drawCircleBatch(partBatch, cam);

  // ─ BH-binary ejecta particles ───────────────────────────
  const ejectaBatch = [];
  for (const s of stars) {
    if (!s.isBinary || !s.binary || !s.binary.accretorIsBH) continue;
    const ec = c1Of(s.binary.colorIdx1);
    for (const p of s.binary.ejecta || []) {
      const fade = Math.min(p.life * 3, 1);
      ejectaBatch.push({
        x: p.x, y: p.y,
        outerR: 2.5 + fade * 3.5, innerR: 0,
        r: ec[0], g: ec[1], b: ec[2], a: 0.35 * fade,
        kind: 2,
      });
    }
  }
  if (ejectaBatch.length) renderer.drawCircleBatch(ejectaBatch, cam);

  // ─ Lensing for any visible BH ───────────────────────────
  const bhData = [];
  const fbW = Math.round(W * DPR);
  const fbH = Math.round(H * DPR);
  if (hasBH) {
    for (const s of stars) {
      let bhX, bhY, bhR;
      if (s.isBlackHole && !s.isBinary) {
        bhX = s.x; bhY = s.y; bhR = s.r * 0.5;
      } else if (s.isBinary && s.binary && s.binary.accretorIsBH) {
        const subs = binaryPositions(s, frame);
        bhX = subs[1].x; bhY = subs[1].y; bhR = subs[1].r * 0.5;
      } else {
        continue;
      }
      // World → clip → framebuffer pixels (matches gameplay.js).
      const clipX = cam[0] * bhX + cam[1] * bhY + cam[2];
      const clipY = cam[3] * bhX + cam[4] * bhY + cam[5];
      bhData.push({
        fbX: (clipX + 1) * 0.5 * fbW,
        fbY: (clipY + 1) * 0.5 * fbH,
        fbR: bhR * zoom * DPR,
      });
    }
  }
  renderer.finalizeFrame(bhData);

  // Position labels.
  for (const { div, star } of labelDoms) {
    const wx = star.world_label_x;
    const wy = star.world_label_y;
    const sx = (wx + camX) * zoom + W / 2;
    const sy = (wy + camY) * zoom + H / 2;
    div.style.left = sx + "px";
    div.style.top = sy + "px";
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
