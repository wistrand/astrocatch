// Challenge-card utilities: per-run stat payload + URL + QR. Self-contained; no dependencies.

// ═════════════════════════════════════════════════════════════
// QR encoder — multi-segment (alphanumeric + byte), EC L or M, auto version 1..6. Adapted from
// ISO/IEC 18004. Pruned to what we need: a short URL with mostly-alpha content plus a '#' fragment
// separator that requires byte mode for one char. Multi-segment lets us bit-pack the alpha portions
// at 5.5 bits/char while keeping byte-mode for chars outside the alphanumeric set. EC M gives ~15%
// damage tolerance — enough to overlay a small centred logo on top of the QR.
//
// Capped at v6 deliberately. v7+ requires extra spec features we don't implement (version-info
// bits in two reserved 6×3 regions) and unequal RS block-group sizes at M v8/v9/v10 (where
// dataCw/numBlocks isn't integral — the spec splits codewords into two groups with sizes
// differing by 1). Our `dataPerBlock = dataCw / numBlocks` slice math assumes uniform splits,
// which holds for v1..v6 in both L and M but breaks at higher versions. Our actual payload
// (28-char URL ≈ 290 bits) fits comfortably in v3 EC M (44 data CW = 352 bits), so v6 is roughly
// 3× the headroom we'll ever need.
// ═════════════════════════════════════════════════════════════

// Data codewords per version (index = version - 1).
const QR_DATA_CW_L = [19, 34, 55, 80, 108, 136];
const QR_DATA_CW_M = [16, 28, 44, 64,  86, 108];
// Total codewords (data + ECC) per version.
const QR_TOTAL_CW  = [26, 44, 70, 100, 134, 172];
// Number of EC blocks per version. v1..v6 keep uniform splits — `dataCw / numBlocks` is integral
// for every entry below. Higher versions would need separate Group-1 / Group-2 metadata.
const QR_EC_BLOCKS_L = [1, 1, 1, 1, 1, 2];
const QR_EC_BLOCKS_M = [1, 1, 1, 2, 2, 4];
// Alignment-pattern centre coordinates per version. v1 has none; v2..v6 have a single centre at
// the listed coordinate.
const QR_ALIGN_POS = [null, [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
// Format info: 5-bit input (2 EC bits + 3 mask bits) → 15-bit BCH-encoded value, then XORed with
// 0x5412. Precomputed for masks 0..7 at EC L (data 01xxx) and EC M (data 00xxx).
const QR_FORMAT_BITS_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];
const QR_FORMAT_BITS_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

// Alphanumeric character set (0..44). Pairs encode at 11 bits;
// a trailing odd char encodes at 6 bits.
const QR_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const QR_ALPHA_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < QR_ALPHA.length; i++) {
  QR_ALPHA_LOOKUP[QR_ALPHA.charCodeAt(i)] = i;
}

// GF(256) tables — built once on first use.
let _gfExp = null, _gfLog = null;
function gfInit() {
  if (_gfExp) return;
  _gfExp = new Uint8Array(512);
  _gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    _gfExp[i] = x;
    _gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive poly x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) _gfExp[i] = _gfExp[i - 255];
}
function gfMul(a, b) {
  if (!a || !b) return 0;
  return _gfExp[_gfLog[a] + _gfLog[b]];
}
// Reed-Solomon: take `data` (Uint8Array) and return ecLen EC bytes.
function rsEncode(data, ecLen) {
  // Build generator polynomial of degree ecLen. Storage convention here: gen[0] = constant term,
  // gen[ecLen] = leading (x^ecLen) coefficient (always 1, monic).
  const gen = new Uint8Array(ecLen + 1);
  gen[0] = 1;
  for (let i = 0; i < ecLen; i++) {
    for (let j = i + 1; j > 0; j--) {
      gen[j] = gen[j - 1] ^ gfMul(gen[j], _gfExp[i]);
    }
    gen[0] = gfMul(gen[0], _gfExp[i]);
  }
  // Polynomial division: buf[0] is the leading coefficient. To cancel it, subtract (lead) · gen
  // aligned so gen's leading term lines up with buf[i]. Since gen[ecLen] is the leading, the
  // contribution into buf[i+k] uses gen[ecLen-k].
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const lead = buf[i];
    if (!lead) continue;
    for (let j = 0; j <= ecLen; j++) {
      buf[i + j] ^= gfMul(gen[ecLen - j], lead);
    }
  }
  return buf.slice(data.length);
}

// ─── Multi-segment data encoding ──────────────────────────
// Each segment is { mode: "alpha" | "byte", text: string }. Byte-mode treats text as UTF-8 bytes;
// alpha-mode requires every char to be in QR_ALPHA. Splits the input into the minimum-bit
// segmentation by greedily extending alpha runs until a non-alpha char forces a switch to byte.

function splitSegments(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    // Greedy alpha run.
    let j = i;
    while (j < text.length && QR_ALPHA_LOOKUP[text.charCodeAt(j)] >= 0) j++;
    if (j > i) {
      segments.push({ mode: "alpha", text: text.slice(i, j) });
      i = j;
      continue;
    }
    // Byte run — until next alpha-eligible char.
    j = i;
    while (j < text.length && QR_ALPHA_LOOKUP[text.charCodeAt(j)] < 0) j++;
    segments.push({ mode: "byte", text: text.slice(i, j) });
    i = j;
  }
  return segments;
}

// Bits used by a segment at the given QR version (header + content). Used to pick the smallest
// version that fits.
function segmentBits(seg, version) {
  if (seg.mode === "alpha") {
    const ccLen = version <= 9 ? 9 : version <= 26 ? 11 : 13;
    const n = seg.text.length;
    return 4 + ccLen + 11 * (n >> 1) + (n & 1 ? 6 : 0);
  }
  // byte
  const ccLen = version <= 9 ? 8 : 16;
  const bytes = new TextEncoder().encode(seg.text).length;
  return 4 + ccLen + 8 * bytes;
}

function pickVersionAndLevel(text, ecLevel) {
  const segs = splitSegments(text);
  const dataTbl = ecLevel === "M" ? QR_DATA_CW_M : QR_DATA_CW_L;
  for (let v = 1; v <= 6; v++) {
    let bits = 0;
    for (const s of segs) bits += segmentBits(s, v);
    if (dataTbl[v - 1] * 8 >= bits) return { version: v, segments: segs };
  }
  throw new Error("QR payload too long");
}

// Bit-array writer used by the multi-segment encoder.
class BitBuffer {
  constructor() { this.bits = []; }
  push(value, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  pushBytes(bytes) {
    for (const b of bytes) this.push(b, 8);
  }
}

function encodeSegments(segments, version, dataCw) {
  const totalBits = dataCw * 8;
  const buf = new BitBuffer();
  for (const s of segments) {
    if (s.mode === "alpha") {
      // Mode indicator 0010, then char count.
      buf.push(0b0010, 4);
      const ccLen = version <= 9 ? 9 : version <= 26 ? 11 : 13;
      buf.push(s.text.length, ccLen);
      for (let i = 0; i + 1 < s.text.length; i += 2) {
        const a = QR_ALPHA_LOOKUP[s.text.charCodeAt(i)];
        const b = QR_ALPHA_LOOKUP[s.text.charCodeAt(i + 1)];
        buf.push(a * 45 + b, 11);
      }
      if (s.text.length & 1) {
        buf.push(QR_ALPHA_LOOKUP[s.text.charCodeAt(s.text.length - 1)], 6);
      }
    } else {
      // Byte mode 0100.
      buf.push(0b0100, 4);
      const ccLen = version <= 9 ? 8 : 16;
      const bytes = new TextEncoder().encode(s.text);
      buf.push(bytes.length, ccLen);
      buf.pushBytes(bytes);
    }
  }
  // Terminator (up to 4 zero bits).
  const term = Math.min(4, totalBits - buf.bits.length);
  for (let i = 0; i < term; i++) buf.bits.push(0);
  // Pad to byte boundary.
  while (buf.bits.length & 7) buf.bits.push(0);
  // Pad bytes alternating 0xEC, 0x11 — first byte ALWAYS 0xEC (ISO 18004 §8.4.9), regardless of
  // overall byte index.
  let padIdx = 0;
  while (buf.bits.length < totalBits) {
    const pad = (padIdx & 1) === 0 ? 0xEC : 0x11;
    buf.push(pad, 8);
    padIdx++;
  }
  // Pack bits into bytes.
  const out = new Uint8Array(dataCw);
  for (let i = 0; i < buf.bits.length; i++) {
    out[i >> 3] |= buf.bits[i] << (7 - (i & 7));
  }
  return out;
}

// Split data into RS blocks. Versions / EC levels we touch (L: v1..v10, M: v1..v10) all use
// equal-size blocks at this range — the only multi-block cases are L v6..v10 (2 blocks) and M
// v4..v10 (2-5 blocks), all uniform.
function buildCodewords(version, ecLevel, dataBytes) {
  gfInit();
  const dataTbl = ecLevel === "M" ? QR_DATA_CW_M : QR_DATA_CW_L;
  const blocksTbl = ecLevel === "M" ? QR_EC_BLOCKS_M : QR_EC_BLOCKS_L;
  const numBlocks = blocksTbl[version - 1];
  const totalCw = QR_TOTAL_CW[version - 1];
  const dataCw = dataTbl[version - 1];
  const ecCwTotal = totalCw - dataCw;
  const ecPerBlock = ecCwTotal / numBlocks;
  const dataPerBlock = dataCw / numBlocks;
  const blocks = [];
  let off = 0;
  for (let b = 0; b < numBlocks; b++) {
    const blockData = dataBytes.slice(off, off + dataPerBlock);
    off += dataPerBlock;
    const blockEc = rsEncode(blockData, ecPerBlock);
    blocks.push({ data: blockData, ec: blockEc });
  }
  // Interleave: byte i of each block in turn (data, then EC).
  const out = new Uint8Array(totalCw);
  let w = 0;
  for (let i = 0; i < dataPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) out[w++] = blocks[b].data[i];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) out[w++] = blocks[b].ec[i];
  }
  return out;
}

// Initialise the matrix with function patterns: finder squares, separators, timing rows/cols,
// alignment patterns (v2+), the dark module, and reserved areas for format/version info.
function makeMatrix(version) {
  const size = 17 + version * 4;
  const modules = [];        // boolean cell value
  const reserved = [];       // boolean: cell is a function pattern
  for (let y = 0; y < size; y++) {
    modules.push(new Uint8Array(size));
    reserved.push(new Uint8Array(size));
  }
  // Finder pattern at (cx, cy): 7×7 block.
  function placeFinder(cx, cy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
          && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        modules[y][x] = (inOuter || inInner) ? 1 : 0;
        reserved[y][x] = 1;
      }
    }
  }
  placeFinder(0, 0);
  placeFinder(size - 7, 0);
  placeFinder(0, size - 7);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = (i & 1) === 0 ? 1 : 0;
    modules[i][6] = (i & 1) === 0 ? 1 : 0;
    reserved[6][i] = 1;
    reserved[i][6] = 1;
  }
  // Alignment patterns (v2+).
  const ap = QR_ALIGN_POS[version - 1];
  if (ap) {
    for (const cy of ap) for (const cx of ap) {
      // Skip alignment patterns that overlap finder zones.
      const skip =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (skip) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          const isOuter = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
          const isCenter = dx === 0 && dy === 0;
          modules[y][x] = (isOuter || isCenter) ? 1 : 0;
          reserved[y][x] = 1;
        }
      }
    }
  }
  // Dark module (always set, just below the top-left finder).
  modules[size - 8][8] = 1;
  reserved[size - 8][8] = 1;
  // Reserve the format-info strips.
  for (let i = 0; i < 9; i++) {
    if (!reserved[i][8]) reserved[i][8] = 1;
    if (!reserved[8][i]) reserved[8][i] = 1;
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = 1;
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = 1;
  }
  return { size, modules, reserved };
}

// Snake the codeword bit stream into the matrix in the standard right-to-left, up-down zigzag,
// skipping reserved cells.
function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  let bitIdx = 0;
  let upward = true;
  for (let xRight = size - 1; xRight > 0; xRight -= 2) {
    if (xRight === 6) xRight--; // skip the timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const x = xRight - dx;
        if (reserved[y][x]) continue;
        const byteIdx = bitIdx >> 3;
        const bit = byteIdx < codewords.length
          ? (codewords[byteIdx] >> (7 - (bitIdx & 7))) & 1
          : 0;
        modules[y][x] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

const MASK_FNS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix, maskIdx) {
  const { size, modules, reserved } = matrix;
  const fn = MASK_FNS[maskIdx];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y][x]) continue;
      if (fn(x, y)) modules[y][x] ^= 1;
    }
  }
}

// Spec penalty rules (only the four standard ones, kept simple).
function penalty(matrix) {
  const { size, modules } = matrix;
  let p = 0;
  // Rule 1: 5+ same-colour modules in a row/column → 3 + (run-5).
  for (let y = 0; y < size; y++) {
    let run = 1, last = modules[y][0];
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === last) { run++; }
      else { if (run >= 5) p += 3 + (run - 5); run = 1; last = modules[y][x]; }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1, last = modules[0][x];
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === last) { run++; }
      else { if (run >= 5) p += 3 + (run - 5); run = 1; last = modules[y][x]; }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  // Rule 2: 2×2 same-colour blocks → 3 each.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y][x];
      if (modules[y][x + 1] === v && modules[y + 1][x] === v && modules[y + 1][x + 1] === v) {
        p += 3;
      }
    }
  }
  // Rule 3: finder-like pattern 1011101 with 4 quiet on either side, in any row/column → 40 each.
  const seq = [1, 0, 1, 1, 1, 0, 1];
  function checkSeq(cells, off) {
    // cells is a 1D array; check positions off..off+10.
    if (off + 10 >= cells.length) return false;
    // 0 0 0 0 [1 0 1 1 1 0 1] = run of 4 zeros + finder, OR [1 0 1 1 1 0 1] 0 0 0 0 = finder + 4
    // zeros.
    let m1 = true, m2 = true;
    for (let i = 0; i < 4; i++) if (cells[off + i] !== 0) m1 = false;
    for (let i = 0; i < 7; i++) if (cells[off + 4 + i] !== seq[i]) m1 = false;
    for (let i = 0; i < 7; i++) if (cells[off + i] !== seq[i]) m2 = false;
    for (let i = 0; i < 4; i++) if (cells[off + 7 + i] !== 0) m2 = false;
    return m1 || m2;
  }
  for (let y = 0; y < size; y++) {
    const row = modules[y];
    for (let x = 0; x <= size - 11; x++) if (checkSeq(row, x)) p += 40;
  }
  for (let x = 0; x < size; x++) {
    const col = new Uint8Array(size);
    for (let y = 0; y < size; y++) col[y] = modules[y][x];
    for (let y = 0; y <= size - 11; y++) if (checkSeq(col, y)) p += 40;
  }
  // Rule 4: dark/light balance. dev = |percent - 50| step 5; 10 each.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
  const pct = (dark / (size * size)) * 100;
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

// Burn the chosen format-info value into both copies of the strip. Per ISO 18004 §8.9 — bit 0 (LSB)
// starts at (col 8, row 0) and runs DOWN col 8 to row 8 (skipping the timing row at row 6), then
// turns at the corner and continues LEFT along row 8 to col 0 (skipping the timing col at col 6).
// Earlier this routine had the X/Y axes swapped on both strips — bits ended up along row 8 / down
// col 8 in mirror image, so scanners read invalid format codes and rejected the QR.
const FORMAT_INFO_COORDS = [
  // Strip 1 layout: [col, row] pairs, bits 0..14.
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [8, 7], [8, 8], [7, 8],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
];
function placeFormat(matrix, maskIdx, ecLevel) {
  const { size, modules } = matrix;
  const bits = ecLevel === "M"
    ? QR_FORMAT_BITS_M[maskIdx]
    : QR_FORMAT_BITS_L[maskIdx];
  for (let i = 0; i < 15; i++) {
    const [x, y] = FORMAT_INFO_COORDS[i];
    const bit = (bits >> i) & 1;
    modules[y][x] = bit;
    // Strip 2 mirror: bits 0..7 run along row 8 from the right edge inward; bits 8..14 run down col
    // 8 from below the dark module to the bottom edge.
    if (i < 8) {
      modules[8][size - 1 - i] = bit;
    } else {
      modules[size - 7 + (i - 8)][8] = bit;
    }
  }
}

// Build a complete QR matrix from a text string. `text` is segmented into alphanumeric and
// byte-mode runs automatically. Returns { size, modules, version, mask, ecLevel }.
export function makeQrMatrix(text, ecLevel = "L") {
  const { version, segments } = pickVersionAndLevel(text, ecLevel);
  const dataTbl = ecLevel === "M" ? QR_DATA_CW_M : QR_DATA_CW_L;
  const dataCw = encodeSegments(segments, version, dataTbl[version - 1]);
  const codewords = buildCodewords(version, ecLevel, dataCw);

  // Find the lowest-penalty mask. Standard exhaustive search.
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = null;
  for (let m = 0; m < 8; m++) {
    const mat = makeMatrix(version);
    placeData(mat, codewords);
    applyMask(mat, m);
    placeFormat(mat, m, ecLevel);
    const p = penalty(mat);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
      bestMatrix = mat;
    }
  }
  return {
    size: bestMatrix.size,
    modules: bestMatrix.modules,
    version,
    mask: bestMask,
    ecLevel,
    penalty: bestPenalty,
  };
}

// Render a QR matrix to a canvas. Each module gets `scale` px;
// adds a `quiet` module-wide white border (4 is the QR spec quiet zone but 2 is fine for screen
// display).
export function renderQrToCanvas(matrix, canvas, scale = 4, quiet = 2) {
  const { size, modules } = matrix;
  const total = (size + quiet * 2) * scale;
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = "#000";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }
}

// Draw a 3D-looking yellow sun in the centre of the QR canvas, snapped to the QR module grid. Every
// module whose centre lies inside the logo radius is FULLY filled with a per-module sampled
// gradient colour; modules outside are untouched. Snap- to-grid keeps Reed-Solomon's recovery
// clean: a fully obscured module reads as missing data (RS fills it in), whereas a partially
// obscured cell injects noise that erodes the EC budget. At ~5 modules radius (≈10% of QR area on
// v3) this sits well within EC M's ~15% damage tolerance.
const SUN_STOPS = [
  [0.00, [255, 251, 208]], // near-white core
  [0.30, [255, 226,  98]], // warm yellow
  [0.75, [255, 179,   0]], // gold
  [1.00, [220, 140,  40]], // warm amber rim — 3D shadow edge
];
function sunRadialColor(t) {
  for (let i = 1; i < SUN_STOPS.length; i++) {
    const [t1, c1] = SUN_STOPS[i - 1];
    const [t2, c2] = SUN_STOPS[i];
    if (t <= t2) {
      const f = (t - t1) / (t2 - t1);
      return [
        Math.round(c1[0] + (c2[0] - c1[0]) * f),
        Math.round(c1[1] + (c2[1] - c1[1]) * f),
        Math.round(c1[2] + (c2[2] - c1[2]) * f),
      ];
    }
  }
  return SUN_STOPS[SUN_STOPS.length - 1][1];
}
// Ray-traced Blinn-Phong shading on a sphere. Each filled module's centre is treated as a sample
// on a unit-radius sphere centred at the QR centre; the closed-form sphere normal at that sample
// drives Lambert diffuse (N·L) and Blinn-Phong specular ((N·H)^k). `phase` is the azimuth of the
// rotating light source, `elevation` is its angle out of the screen plane (0 = equator, π/2 =
// directly toward the viewer along +z, lighting the whole near hemisphere uniformly). Defaults
// match the original static-render look. The MODULE MASK is unchanged from the earlier flat-shaded
// version (same rMod=4.5 circle), so the outline reads identically — only the per-module colour
// changes.
export function drawSunLogo(canvas, modulesPerSide, scale, quiet, phase, elevation) {
  if (phase === undefined) phase = -3 * Math.PI / 4;
  if (elevation === undefined) elevation = Math.PI / 6;
  const ctx = canvas.getContext("2d");
  const cxMod = modulesPerSide / 2;
  const cyMod = modulesPerSide / 2;
  // Radius 4.5 (not 5) so the discrete cardinal-axis tabs drop out: at r=5, modules at (centre±4.5,
  // centre±0.5) sit at distance 4.528 (inside) but the next column is at 5.025 (outside), producing
  // 2-module tabs detached from the main diagonal body. Pulling r below 4.528 collapses them.
  const rMod = 4.5;
  // Light direction L (unit). Screen-space: x→right, y→down, z→out of screen.
  const cE = Math.cos(elevation), sE = Math.sin(elevation);
  const Lx = Math.cos(phase) * cE;
  const Ly = Math.sin(phase) * cE;
  const Lz = sE;
  // Half-vector H = normalize(L + V), V = (0, 0, 1). Used for Blinn-Phong specular peak.
  const hMag = Math.hypot(Lx, Ly, Lz + 1);
  const Hx = Lx / hMag;
  const Hy = Ly / hMag;
  const Hz = (Lz + 1) / hMag;
  // Shininess controls the specular spot size; higher = tighter. 28 covers ~2 modules at this
  // scale. Highlight target is BRIGHT YELLOW, not white — additive shading on a near-white body
  // stop blew the peak to pure white, which read as plastic / wet. Lerping the body colour toward
  // a saturated-yellow target instead keeps the sphere reading as a sun.
  const SHININESS = 28;
  const SPEC_R = 255, SPEC_G = 240, SPEC_B = 80;
  for (let my = 0; my < modulesPerSide; my++) {
    for (let mx = 0; mx < modulesPerSide; mx++) {
      // Mask: only fill modules whose centre lies inside the sun.
      const sunDx = mx + 0.5 - cxMod;
      const sunDy = my + 0.5 - cyMod;
      if (Math.hypot(sunDx, sunDy) > rMod) continue;
      // Sphere normal at this sample, closed-form: nx,ny from screen offset; nz from sphere
      // equation z² = r² - x² - y². Max guards against tiny-negative floats at the rim.
      const nx = sunDx / rMod;
      const ny = sunDy / rMod;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      // Lambert diffuse — clamped at terminator so shadow side is dark-ambient only.
      const NdotL = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      // Body colour interpolated from the gradient table by "darkness": fully lit → core-white,
      // terminator/shadow → amber rim.
      let [r, g, b] = sunRadialColor(1 - NdotL);
      // Specular only on the lit hemisphere. Without the NdotL gate, edge-on shading near the
      // shadow rim could still register a spurious highlight from a positive N·H component. Lerp
      // toward a yellow target instead of additive — peak highlight lands on saturated yellow,
      // never pure white.
      if (NdotL > 0) {
        const NdotH = Math.max(0, nx * Hx + ny * Hy + nz * Hz);
        const k = Math.pow(NdotH, SHININESS);
        r = (r + (SPEC_R - r) * k) | 0;
        g = (g + (SPEC_G - g) * k) | 0;
        b = (b + (SPEC_B - b) * k) | 0;
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((mx + quiet) * scale, (my + quiet) * scale, scale, scale);
    }
  }
}

// ═════════════════════════════════════════════════════════════
// APNG encoder — bake an animated QR-with-spinning-sun into a single image/png blob. APNG is the
// only multi-frame format that works in <img src>; we use canvas.toBlob to get each frame as a
// regular PNG and stitch them by reusing the IHDR + IDAT data and inserting acTL + per-frame fcTL
// + fdAT chunks. No external library — the PNG container is simple enough to assemble inline.
//
// Output is a valid PNG to non-APNG readers (they show the first frame) and an animated PNG to
// APNG-aware readers (Chrome 59+, Firefox, Safari 14+). Use the resulting Uint8Array as a Blob
// with type "image/png" and an Object URL is a working <img> source.
// ═════════════════════════════════════════════════════════════

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (~crc) >>> 0;
}

function writePngChunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const v = new DataView(out.buffer);
  v.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}

function parsePngChunks(buf) {
  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    const len = (buf[p] << 24) | (buf[p+1] << 16) | (buf[p+2] << 8) | buf[p+3];
    const type = String.fromCharCode(buf[p+4], buf[p+5], buf[p+6], buf[p+7]);
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

// Encode a canvas-driven animation as an APNG. `drawFrame(i, total, target)` is the caller-
// supplied per-frame render function that mutates `target` — the encoder snapshots target via
// canvas.toBlob after each call. `fps` controls playback speed.
//
// Optional `deltaRect = { x, y, w, h }` switches on delta-frame encoding: frame 0 is rendered
// onto the full `canvas` (size W×H, target = canvas), all subsequent frames are rendered onto
// a smaller offscreen canvas (size w×h, target = deltaCanvas) and composited at (x, y) into the
// playback buffer. Frame 0's dispose stays NONE so its content persists in the buffer; delta
// frames use dispose=PREVIOUS so the next frame's delta lands on the unchanged frame-0 state.
// Drops file size roughly 5× for our use case where only a small region animates.
export async function encodeAnimatedQrPng(canvas, drawFrame, frameCount, fps, deltaRect) {
  // 1. Set up the delta-frame canvas if requested.
  let deltaCanvas = null;
  if (deltaRect) {
    deltaCanvas = document.createElement("canvas");
    deltaCanvas.width = deltaRect.w;
    deltaCanvas.height = deltaRect.h;
  }
  // 2. Render each frame onto the appropriate target and snapshot.
  const framePngs = [];
  for (let i = 0; i < frameCount; i++) {
    const target = (deltaCanvas && i > 0) ? deltaCanvas : canvas;
    drawFrame(i, frameCount, target);
    const blob = await new Promise((r) => target.toBlob(r, "image/png"));
    framePngs.push(new Uint8Array(await blob.arrayBuffer()));
  }
  // 3. Pull IHDR from frame 0 (full canvas). This drives the APNG's overall dimensions.
  const firstChunks = parsePngChunks(framePngs[0]);
  const ihdr = firstChunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("APNG: first frame has no IHDR");
  const w = (ihdr.data[0] << 24) | (ihdr.data[1] << 16) | (ihdr.data[2] << 8) | ihdr.data[3];
  const h = (ihdr.data[4] << 24) | (ihdr.data[5] << 16) | (ihdr.data[6] << 8) | ihdr.data[7];
  // 4. Assemble APNG: signature + IHDR + acTL + per-frame (fcTL + IDAT/fdAT) + IEND.
  const parts = [PNG_SIGNATURE, writePngChunk("IHDR", ihdr.data)];
  const acTL = new Uint8Array(8);
  new DataView(acTL.buffer).setUint32(0, frameCount);
  // 0 plays = infinite loop. Second uint32 stays 0.
  parts.push(writePngChunk("acTL", acTL));
  let seq = 0;
  for (let i = 0; i < frameCount; i++) {
    // Delta frames specify the sub-rect they occupy via fcTL x/y/w/h; frame 0 covers the full
    // canvas. Mixing frame sizes is fine — each frame's IDAT/fdAT stream encodes its own
    // dimensions per its source PNG's IHDR (which we don't write to the APNG, only the
    // composite IHDR survives).
    const useDelta = deltaRect && i > 0;
    const frameW = useDelta ? deltaRect.w : w;
    const frameH = useDelta ? deltaRect.h : h;
    const frameX = useDelta ? deltaRect.x : 0;
    const frameY = useDelta ? deltaRect.y : 0;
    const fcTL = new Uint8Array(26);
    const fv = new DataView(fcTL.buffer);
    fv.setUint32(0, seq++);
    fv.setUint32(4, frameW);
    fv.setUint32(8, frameH);
    fv.setUint32(12, frameX);
    fv.setUint32(16, frameY);
    fv.setUint16(20, 1);     // delay_num
    fv.setUint16(22, fps);   // delay_den (delay = num/den seconds = 1/fps)
    // Dispose: frame 0 keeps its content (NONE = 0); delta frames revert their sub-rect to the
    // state-before-this-frame (PREVIOUS = 2), so the next delta composites back onto the
    // frame-0 base instead of stacking on the previous delta.
    fcTL[24] = useDelta ? 2 : 0;
    fcTL[25] = 0;            // blend_op: SOURCE (overwrite the rect's pixels)
    parts.push(writePngChunk("fcTL", fcTL));
    const chunks = parsePngChunks(framePngs[i]);
    const idats = chunks.filter((c) => c.type === "IDAT");
    if (i === 0) {
      // First frame's data lives in IDAT chunks (decoders that don't understand APNG render this).
      for (const idat of idats) parts.push(writePngChunk("IDAT", idat.data));
    } else {
      // Subsequent frames go in fdAT chunks: a 4-byte sequence number prefix then the raw IDAT
      // bytes. APNG decoders concatenate fdAT payloads (sans seq) and inflate as one DEFLATE
      // stream per frame, same as for IDAT.
      for (const idat of idats) {
        const fdat = new Uint8Array(4 + idat.data.length);
        new DataView(fdat.buffer).setUint32(0, seq++);
        fdat.set(idat.data, 4);
        parts.push(writePngChunk("fdAT", fdat));
      }
    }
  }
  parts.push(writePngChunk("IEND", new Uint8Array(0)));
  // 5. Concatenate.
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ═════════════════════════════════════════════════════════════
// Run-stat payload — bit-packed + 5-bit checksum → base32 fragment.
//
// 4 bits  format version (currently 2)
// 1 bit   launch_window (was has_seed in v1; seed is now always encoded)
// 20 bits score (0..1,048,575)
// 10 bits starsVisited (0..1023)
// 4 bits  streakPeak (0..15)
// 8 bits  blazingCount (0..255)
// 8 bits  quickCount
// 8 bits  slowCount
// 6 bits  cometsCaught (0..63)
// 4 bits  deathCause (0..15 enum)
// 24 bits variant census (8 variants × 3 bits)
// 32 bits seed (always present)
// 5 bits  checksum (low 5 bits of CRC-16/CCITT-FALSE over the byte-aligned payload pre-checksum)
//
// 134 bits bit-packed → 17 bytes (the 5-bit checksum tucks INTO the byte-pad bits that the byte-
// boundary padding would otherwise waste, so it costs no extra length). Encoded base32 = 28 chars
// always.
//
// v1 → v2: in practice every encoded challenge had has_seed=1 (gameplay.js always passes a seed),
// so the conditional branch was dead. v2 locks the seed in and reuses the freed bit for
// `launch_window` — true if the sender had the launch-window indicator on. The recipient's init()
// reads this bit and enables the indicator for the challenge run, so both players experience the
// same hint visibility.
//
// The checksum deters casual URL-fragment forgery — random edits pass at ~1/32 instead of ~100%. It
// does not authenticate the code (anyone reading challenge.js can compute valid checksums) — that
// would need server-side signing, which doesn't fit a static-page game.
// ═════════════════════════════════════════════════════════════

const CHALLENGE_FORMAT_VERSION = 2;

// CRC-16/CCITT-FALSE truncated to 5 bits — we use only the low 5 bits as the on-wire checksum (1/32
// random-edit pass-rate). Full 16-bit CRC is computed and masked rather than a custom CRC-5
// polynomial for code-size simplicity.
function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000)
        ? ((crc << 1) ^ 0x1021) & 0xFFFF
        : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}
// Variant census slots in fixed order — adding a new variant means bumping CHALLENGE_FORMAT_VERSION
// because the slot indices shift.
const VARIANT_KEYS = [
  "azazel", "teapot", "blackHole", "ringworld",
  "nebula", "pulsar", "binary", "monolith",
];
// Death-cause enum — also part of the format contract.
export const DEATH_CAUSES = {
  unknown: 0,
  escape: 1,
  starCrash: 2,
  binaryCrash: 3,
  blackHoleCrash: 4,
};

function clampBits(v, bits) {
  const max = (1 << bits) - 1;
  return Math.max(0, Math.min(max, v | 0));
}

class BitStream {
  constructor() {
    this.bits = [];
  }
  push(value, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  // Special handling for 32-bit values that exceed JS bitshift safe range.
  push32(value) {
    const lo = value & 0xFFFF;
    const hi = (value >>> 16) & 0xFFFF;
    this.push(hi, 16);
    this.push(lo, 16);
  }
  toBytes() {
    const len = Math.ceil(this.bits.length / 8);
    const out = new Uint8Array(len);
    for (let i = 0; i < this.bits.length; i++) {
      out[i >> 3] |= this.bits[i] << (7 - (i & 7));
    }
    return out;
  }
}

// Uppercase base32 (RFC 4648). All chars are in QR's alphanumeric set so the challenge fragment
// encodes at 5.5 bits/char in QR mode (alpha) instead of 8 bits/char (byte). Trade-off vs
// base64url: payload grows by ~28% in chars, but the QR shrinks by ~40% in bits per char.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function bytesToB32(bytes) {
  let out = "";
  let buf = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buf >> bits) & 0x1F];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buf << (5 - bits)) & 0x1F];
  return out;
}

// Bit-stream reader for the decoder side. Accepts a Uint8Array and lets the caller pull MSB-first
// bit groups in order.
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = this.pos >> 3;
      const bitIdx = 7 - (this.pos & 7);
      const bit = byteIdx < this.bytes.length
        ? (this.bytes[byteIdx] >> bitIdx) & 1
        : 0;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v;
  }
  // Special path for 32-bit reads — bitshifts above 31 are undefined in JS; assemble via two 16-bit
  // halves.
  read32() {
    const hi = this.read(16);
    const lo = this.read(16);
    return ((hi * 0x10000) + lo) >>> 0;
  }
}

const B32_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < B32_ALPHABET.length; i++) {
  B32_LOOKUP[B32_ALPHABET.charCodeAt(i)] = i;
  // Accept lowercase letters too — but only for the A-Z run. Adding +32 unconditionally collides
  // with letters: '2'+32 == 'R', etc., which would overwrite the uppercase letter slots and corrupt
  // the table.
  const code = B32_ALPHABET.charCodeAt(i);
  if (code >= 65 && code <= 90) B32_LOOKUP[code + 32] = i;
}
function b32ToBytes(s) {
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // B32_LOOKUP is a 128-entry Int8Array. Out-of-bounds reads
    // return undefined, and `undefined < 0` is false — so without
    // the explicit charCode bound a non-ASCII char (emoji, é, …) would slip past the validity check
    // and `(buf << 5) | undefined` would silently treat it as value 0, corrupting the decode.
    if (code >= 128) return null;
    const v = B32_LOOKUP[code];
    if (v < 0) return null;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xFF);
    }
  }
  return new Uint8Array(out);
}

// Decode a challenge code (the value of the URL fragment) back into a stats object. Returns null on
// any parse error so callers can no-op silently. The visible URL carries the code in lowercase, but
// base32 is canonically uppercase — normalise here so the decoder doesn't care which the caller
// hands us. CRC-16 is verified before the payload is parsed, so any random insert/delete/bit-flip
// (the trivial fake-score attack) is rejected with overwhelming probability.
function rejectChallenge(reason, code) {
  // Quiet console breadcrumb so a tampered or stale URL doesn't fail silently. Stays at log level
  // (not warn/error) — a bad hash from random web traffic isn't an app error.
  console.log("[challenge] rejected:", reason, "code=" + code);
  return null;
}
export function decodeChallengeCode(code) {
  if (!code) return null;
  const bytes = b32ToBytes(code.toUpperCase());
  if (!bytes) return rejectChallenge("invalid base32 char", code);
  // v2 fixed length: always 17 bytes (134 payload+checksum bits → 17 bytes byte-padded). The v1
  // 13-byte no-seed shape was dropped — every encoded challenge now carries a seed.
  if (bytes.length !== 17) {
    return rejectChallenge("wrong length: got " + bytes.length + "B, expected 17B", code);
  }
  // Peek at format BEFORE trusting any bits. byte 0 layout: bits 7..4 = format, bit 3 =
  // launch_window, bits 2..0 = top of score.
  const fmt = (bytes[0] >> 4) & 0xF;
  if (fmt !== CHALLENGE_FORMAT_VERSION) {
    return rejectChallenge("format=" + fmt + " (expected " + CHALLENGE_FORMAT_VERSION + ")", code);
  }
  // Verify the inline 5-bit checksum. Reconstruct the payload-only byte view by zeroing the last
  // byte's bits 6..2 (which hold the checksum on the wire) and bits 1..0 (encoder pad zeros). Bit
  // 7 of the last byte is the final payload bit.
  const checkBytes = new Uint8Array(bytes);
  checkBytes[16] &= 0x80;
  const want = crc16(checkBytes) & 0x1F;
  const got = (bytes[16] >> 2) & 0x1F;
  if (want !== got) {
    return rejectChallenge(
      "checksum mismatch (got 0x" + got.toString(16) + ", want 0x" + want.toString(16) + ")", code);
  }
  const r = new BitReader(bytes);
  // fmt re-read (already validated) just to advance the cursor.
  r.read(4);
  const launchWindow = r.read(1) === 1;
  const score = r.read(20);
  const starsVisited = r.read(10);
  const streakPeak = r.read(4);
  const blazingCount = r.read(8);
  const quickCount = r.read(8);
  const slowCount = r.read(8);
  const cometsCaught = r.read(6);
  const deathCause = r.read(4);
  const variants = {};
  for (const k of VARIANT_KEYS) variants[k] = r.read(3);
  const seed = r.read32();
  return {
    score, starsVisited, streakPeak,
    blazingCount, quickCount, slowCount,
    cometsCaught, deathCause, variants, seed, launchWindow,
  };
}

// Build the challenge URL. `stats` = { score, starsVisited, streakPeak, blazingCount, quickCount,
// slowCount, cometsCaught, deathCause, variants{...}, seed }. `originUrl` defaults to the page's
// origin so the link works regardless of host. We drop the trailing "/" when the page is hosted at
// the site root (which is true for production AND for local dev), saving one alphanumeric char in
// the QR; sub-path deployments keep the path-with-slash since servers / SPA routing usually treat
// /games/foo and /games/foo/ as different. Browsers normalise the empty path back to "/" on load,
// so http://host:port#FRAG and http://host:port/#FRAG resolve identically.
export function buildChallengeUrl(stats, originUrl) {
  let base;
  if (originUrl) {
    // Strip the slash only when the URL is origin-only or "origin/" — i.e. the page is at the site
    // root.
    try {
      const u = new URL(originUrl);
      base = (u.pathname === "/" || u.pathname === "") ? u.origin : originUrl;
    } catch (_) {
      base = originUrl;
    }
  } else {
    const path = location.pathname;
    base = (path === "/") ? location.origin : (location.origin + path);
  }
  const bs = new BitStream();
  bs.push(CHALLENGE_FORMAT_VERSION, 4);
  // launch_window bit (formerly has_seed in v1). Recipient's init() reads it and enables the
  // launch-window indicator for the challenge run so both players see the same hint state.
  bs.push(stats.launchWindow ? 1 : 0, 1);
  bs.push(clampBits(stats.score, 20), 20);
  bs.push(clampBits(stats.starsVisited, 10), 10);
  bs.push(clampBits(stats.streakPeak, 4), 4);
  bs.push(clampBits(stats.blazingCount, 8), 8);
  bs.push(clampBits(stats.quickCount, 8), 8);
  bs.push(clampBits(stats.slowCount, 8), 8);
  bs.push(clampBits(stats.cometsCaught, 6), 6);
  bs.push(clampBits(stats.deathCause, 4), 4);
  const census = stats.variants || {};
  for (const k of VARIANT_KEYS) {
    bs.push(clampBits(census[k] || 0, 3), 3);
  }
  // Seed is unconditional in v2. Falsy / undefined seeds get coerced to 0 via `>>> 0`, but
  // gameplay's setRunSeed always installs a non-zero seed before challenge encoding (any path
  // that produces a 0 there hits the PRNG-degeneration guard in init() that remaps 0 → 1).
  bs.push32((stats.seed || 0) >>> 0);
  // Compute checksum over the payload-only byte view (134 bits → 17 bytes with the trailing 2
  // bits all zero). Take low 5 bits of CRC-16, push them into the bitstream; those 5 bits land
  // inside the previously-zero pad region of the last data byte, so the byte count doesn't grow.
  const tmpBytes = bs.toBytes();
  bs.push(crc16(tmpBytes) & 0x1F, 5);
  // Visible URL keeps the fragment lowercase so the link looks tidy to humans; the QR-render path
  // uppercases the whole URL on its way into the encoder so the QR can still pack it as
  // alphanumeric (5.5 bits/char). The decoder always toUpperCases before parsing, so either case
  // round-trips.
  const enc = bytesToB32(bs.toBytes()).toLowerCase();
  return `${base}#${enc}`;
}
