// Shared rendering / data helpers for star variants.
// Pure functions + per-star data construction. No DOM, no audio,
// no input. Imported by both gameplay.js (live game) and
// debug.js (variant inspector).

import { c1Of } from "./renderer.js";

export const PALETTE_LEN = 7;

// ─── Comets ────────────────────────────────────────────────
// Newton's method on Kepler's equation; 8 iterations handles
// e ≤ ~0.93 reliably with a convergence early-exit.
export function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 8; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

// Pure: world position of a comet at the given frame.
export function cometPosition(star, comet, frame) {
  const M = (frame * comet.meanMotion + comet.phase) % (Math.PI * 2);
  const E = solveKepler(M, comet.e);
  const cosE = Math.cos(E);
  const r = comet.a * (1 - comet.e * cosE);
  const sqrtFac = Math.sqrt((1 + comet.e) / (1 - comet.e));
  const theta = 2 * Math.atan2(
    sqrtFac * Math.sin(E / 2),
    Math.cos(E / 2)
  );
  const xOrb = r * Math.cos(theta);
  const yOrb = r * Math.sin(theta);
  const cw = Math.cos(comet.omega);
  const sw = Math.sin(comet.omega);
  return {
    x: star.x + xOrb * cw - yOrb * sw,
    y: star.y + xOrb * sw + yOrb * cw,
    r,
  };
}

// Append a comet's draw instances (multi-syndyne tail + coma +
// core) to the given circle batch. Fully self-contained — the
// caller supplies the comet, its star, the current frame, and
// an array to push into.
const _ALL_SYNDYNES = [
  { wm: 0.4, al: 0.3 },
  { wm: 1.0, al: 0.5 },
  { wm: 1.8, al: 0.22 },
];
export function appendCometBatch(star, comet, frame, batch) {
  const sc = c1Of(star.colorIdx);
  const pos = cometPosition(star, comet, frame);
  const periDist = comet.a * (1 - comet.e);
  const apoDist = comet.a * (1 + comet.e);
  const activity = Math.max(
    0, 1 - (pos.r - periDist) / (apoDist - periDist)
  );
  const TRAIL_N = 20;
  const TRAIL_STEP = 6;
  const BASE_WIND = 3.0;
  const nSyn = Math.min(comet.numSyndynes || 1, _ALL_SYNDYNES.length);
  const syndynes = nSyn === 1
    ? [_ALL_SYNDYNES[1]]
    : nSyn === 2
      ? [_ALL_SYNDYNES[0], _ALL_SYNDYNES[1]]
      : _ALL_SYNDYNES;
  const pastPos = [];
  for (let t = TRAIL_N - 1; t >= 1; t--) {
    const pp = cometPosition(star, comet, frame - t * TRAIL_STEP);
    const wdx = pp.x - star.x;
    const wdy = pp.y - star.y;
    const wd = Math.hypot(wdx, wdy) || 1;
    pastPos.push({ t, px: pp.x, py: pp.y, nx: wdx / wd, ny: wdy / wd });
  }
  for (let syn = 0; syn < syndynes.length; syn++) {
    const wind = BASE_WIND * syndynes[syn].wm;
    const synAlpha = syndynes[syn].al;
    for (let k = 0; k < pastPos.length; k++) {
      const { t, px, py, nx, ny } = pastPos[k];
      const fade = 1 - t / TRAIL_N;
      const pr = comet.radius * (0.4 + 0.6 * fade);
      batch.push({
        x: px + nx * t * wind,
        y: py + ny * t * wind,
        outerR: pr * 2.8, innerR: 0,
        r: sc[0] * fade, g: sc[1] * fade, b: sc[2] * fade,
        a: fade * synAlpha,
        kind: 2,
      });
    }
  }
  // Coma + core.
  const comaR = comet.radius * (3 + activity * 8);
  const comaA = 0.2 + activity * 0.5;
  batch.push({
    x: pos.x, y: pos.y,
    outerR: comaR, innerR: 0,
    r: sc[0], g: sc[1], b: sc[2], a: comaA, kind: 2,
  });
  batch.push({
    x: pos.x, y: pos.y,
    outerR: comet.radius, innerR: 0,
    r: 1, g: 1, b: 1, a: 1, kind: 0,
  });
  return pos;
}

// ─── Binary stars ──────────────────────────────────────────
// Sub-star positions at a given physics frame. Used by live
// physics (crash detection), prediction, and rendering.
export function binaryPositions(star, frame) {
  const b = star.binary;
  if (!b) return null;
  const angle = frame * b.omega + b.phase;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return [
    { x: star.x + ca * b.d1, y: star.y + sa * b.d1, r: b.r1 },
    { x: star.x - ca * b.d2, y: star.y - sa * b.d2, r: b.r2 },
  ];
}

// Mutate `s` into a binary. Uses Math.random() for parameters
// — caller is responsible for any deterministic seeding.
export function assignBinary(s) {
  const q = 0.2 + Math.random() * 0.45;
  const totalGM = s.gm;
  const gm1 = totalGM * q / (1 + q);
  const gm2 = totalGM / (1 + q);
  let r1 = s.r * Math.cbrt(q / (1 + q)) * 0.72;
  let r2 = s.r * Math.cbrt(1 / (1 + q)) * 0.72;
  const minSep = (r1 + r2) * 2.2;
  const sep = Math.max(minSep, s.r * (0.8 + Math.random() * 0.4));
  const d1 = sep / (1 + q);
  const d2 = sep * q / (1 + q);
  const periodFrames = 400 + Math.random() * 400;
  const spin = Math.random() < 0.5 ? 1 : -1;
  s.isBinary = true;
  s.planets = null;
  s.binary = {
    q, sep, r1, r2, gm1, gm2, d1, d2,
    omega: spin * (Math.PI * 2) / periodFrames,
    phase: Math.random() * Math.PI * 2,
    colorIdx1: s.colorIdx,
    colorIdx2: Math.floor(Math.random() * PALETTE_LEN),
    accretorIsBH: s.isBlackHole,
    stream: null,
  };
}

// ─── BH-binary ejecta ──────────────────────────────────────
export const EJECTA_MAX = 160;
export const EJECTA_SPAWN_PER_FRAME = 2;
export const EJECTA_GM_MULT = 0.2;

// Step ejecta particles forward one frame. `frame` is used to
// position the binary's sub-stars (donor + accretor) for the
// physics step; particles are pulled by the inflated accretor
// gravity and weakly repelled by the donor.
export function updateEjecta(stars, frame) {
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (!s.isBinary || !s.binary || !s.binary.accretorIsBH) continue;
    const b = s.binary;
    if (!b.ejecta) b.ejecta = [];
    const subs = binaryPositions(s, frame);
    const donor = subs[0], accr = subs[1];
    for (let j = 0; j < EJECTA_SPAWN_PER_FRAME; j++) {
      if (b.ejecta.length >= EJECTA_MAX) break;
      const toAcc = Math.atan2(accr.y - donor.y, accr.x - donor.x);
      const a = toAcc + (Math.random() - 0.5) * Math.PI * 0.33;
      const spd = 0.3 + Math.random() * 0.3;
      b.ejecta.push({
        x: donor.x + Math.cos(a) * donor.r * 1.05,
        y: donor.y + Math.sin(a) * donor.r * 1.05,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life: 1,
      });
    }
    const accrGM = b.gm2 * EJECTA_GM_MULT;
    const donorGM = b.gm1 * 0.3;
    const soft = 8;
    for (let j = b.ejecta.length - 1; j >= 0; j--) {
      const p = b.ejecta[j];
      p.life -= 0.006;
      if (p.life <= 0) { b.ejecta.splice(j, 1); continue; }
      let dx = accr.x - p.x, dy = accr.y - p.y;
      let d2 = dx * dx + dy * dy + soft;
      let d = Math.sqrt(d2);
      let a = accrGM / d2;
      p.vx += dx / d * a * 0.12;
      p.vy += dy / d * a * 0.12;
      dx = p.x - donor.x; dy = p.y - donor.y;
      d2 = dx * dx + dy * dy + soft;
      d = Math.sqrt(d2);
      a = donorGM / d2;
      p.vx += dx / d * a * 0.05;
      p.vy += dy / d * a * 0.05;
      const dAccr = Math.hypot(p.x - accr.x, p.y - accr.y);
      const dragT = Math.min(1, accr.r * 3 / Math.max(dAccr, 1));
      const drag = 0.998 - dragT * 0.03;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx;
      p.y += p.vy;
      dx = p.x - accr.x; dy = p.y - accr.y;
      if (dx * dx + dy * dy < accr.r * accr.r * 0.5) {
        b.ejecta.splice(j, 1);
      }
    }
  }
}
