/**
 * Small image files made in the test, for the raster-mark and favicon
 * rules: a real PNG (any size, one color or noise), WebP headers (VP8,
 * VP8L, VP8X: only what the validator reads), and an ICO wrapping a PNG.
 * Nothing is copied from outside the repo.
 */
import * as zlib from "zlib";

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * An RGBA PNG of `width`×`height`, filled with `rgba`, or with
 * deterministic noise (which does not compress: a large file) when
 * `noise` is set.
 */
export function png(
  width: number,
  height: number,
  opts: { rgba?: [number, number, number, number]; noise?: boolean } = {},
): Buffer {
  const [r, g, b, a] = opts.rgba ?? [200, 80, 40, 255];
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      if (opts.noise) {
        for (let i = 0; i < 4; i++) {
          // xorshift32
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          raw[o + i] = seed & 0xff;
        }
      } else {
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
        raw[o + 3] = a;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function riff(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + 8 + payload.length, 4);
  head.write("WEBP", 8, "latin1");
  head.write(fourcc, 12, "latin1");
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

/** A WebP header of `width`×`height` in one of its three forms. */
export function webp(
  width: number,
  height: number,
  form: "VP8L" | "VP8X" | "VP8 " = "VP8L",
): Buffer {
  if (form === "VP8L") {
    const p = Buffer.alloc(16);
    p[0] = 0x2f;
    p.writeUInt32LE(
      ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14),
      1,
    );
    return riff("VP8L", p);
  }
  if (form === "VP8X") {
    const p = Buffer.alloc(16);
    p.writeUIntLE(width - 1, 4, 3);
    p.writeUIntLE(height - 1, 7, 3);
    return riff("VP8X", p);
  }
  const p = Buffer.alloc(16);
  p[3] = 0x9d;
  p[4] = 0x01;
  p[5] = 0x2a;
  p.writeUInt16LE(width & 0x3fff, 6);
  p.writeUInt16LE(height & 0x3fff, 8);
  return riff("VP8 ", p);
}

/** An .ico holding one PNG image. */
export function ico(image: Buffer = png(32, 32)): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = 32;
  head[7] = 32;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(image.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, image]);
}
