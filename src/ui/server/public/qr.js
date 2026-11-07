/**
 * A tiny QR code encoder (SEC-2a, "Pair a device"): byte mode, error
 * correction level M, versions 1 to 10 (up to 213 bytes, enough for a
 * sign-in link). Written for Den from ISO/IEC 18004; no dependency, no CDN.
 * Its matrices are checked against an independent encoder's in
 * tests/unit/server/qr.test.ts.
 *
 *   qrMatrix(text, { mask }?)  rows of booleans (true: dark), no quiet zone
 *   qrSvg(text, { scale, margin }?)  an SVG string, dark on light
 */

// Level M, versions 1..10: ECC codewords per block, and blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ECC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
const FORMAT_BITS_M = 0;

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((c, i) => (out[i] ^= gfMul(c, factor)));
  }
  return out;
}

function alignPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * ECC_BLOCKS[ver];
}

function utf8(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

/** The data codewords for `bytes` at version `ver` (mode, count, pad). */
function encodeData(bytes, ver) {
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8)
    out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function withEcc(data, ver) {
  const nBlocks = ECC_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]);
    });
  return out;
}

function makeGrid(ver) {
  const size = ver * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    mods[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size)
          set(x, y, d !== 2 && d !== 4);
      }
  const al = alignPositions(ver);
  const last = al.length - 1;
  al.forEach((ax, i) =>
    al.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last)) return;
      if (i === last && j === 0) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(set, size, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, mods, fn, set };
}

function drawFormat(set, size, mask) {
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]);
    lines.push(m.map((row) => row[i]));
  }
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    for (let i = 0; i < n; ) {
      let j = i;
      while (j < n && line[j] === line[i]) j++;
      if (j - i >= 5) score += 3 + (j - i - 5);
      i = j;
    }
    for (let i = 0; i + 7 <= n; i++) {
      if (!finder.every((v, k) => line[i + k] === v)) continue;
      const light = (a, b) => {
        for (let k = a; k < b; k++)
          if (k >= 0 && k < n && line[k]) return false;
        return true;
      };
      if (light(i - 4, i) || light(i + 7, i + 11)) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (
        x + 1 < n &&
        y + 1 < n &&
        m[y][x] === m[y][x + 1] &&
        m[y][x] === m[y + 1][x] &&
        m[y][x] === m[y + 1][x + 1]
      )
        score += 3;
    }
  const total = n * n;
  score += 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
  return score;
}

/**
 * The QR code for `text` (UTF-8, byte mode, level M), as rows of booleans
 * (true: dark), no quiet zone. `mask` 0..7 fixes the mask; by default the
 * one with the lowest penalty. Throws when `text` is longer than version
 * 10 holds (213 bytes).
 */
export function qrMatrix(text, opts = {}) {
  const bytes = utf8(text);
  let ver = 1;
  const need = (v) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
  while (ver <= MAX_VERSION && need(ver) > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION)
    throw new Error(`QR: ${bytes.length} bytes is too long (213 at most)`);
  const code = withEcc(encodeData(bytes, ver), ver);
  const { size, mods, fn } = makeGrid(ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < code.length * 8) {
          mods[y][x] = ((code[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }
  const masked = (mask) => {
    const m = mods.map((row) => row.slice());
    const put = (x, y, dark) => (m[y][x] = dark);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    drawFormat(put, size, mask);
    return m;
  };
  if (Number.isInteger(opts.mask) && opts.mask >= 0 && opts.mask <= 7)
    return masked(opts.mask);
  let best = null;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const m = masked(k);
    const s = penalty(m);
    if (s < bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}

/** `text`'s QR code as an SVG (one path), with a quiet zone of `margin` modules. */
export function qrSvg(text, opts = {}) {
  const m = qrMatrix(text);
  const scale = opts.scale ?? 4;
  const margin = opts.margin ?? 4;
  const n = m.length + margin * 2;
  let d = "";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
    `width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges" role="img">` +
    // Black on white whatever the theme: a scanner needs that contrast
    // (an inverted code fails on many phones), so no theme token here.
    `<rect width="${n}" height="${n}" fill="white"/>` +
    `<path d="${d}" fill="black"/></svg>`
  );
}
