// Generates the PWA icons from code so they are reproducible and no binary
// design file has to live in the repo.
//
//   node scripts/make-icons.mjs           write public/icon-*.png
//   node scripts/make-icons.mjs --check   verify the committed PNGs match
//
// The check decodes the committed files and compares *pixels*, not file bytes.
// Comparing bytes would make the check depend on the deflate implementation in
// whichever Node build happens to run it, and fail on an unrelated change.
//
// The decoder handles only what this script writes: 8-bit RGBA, filter 0, no
// interlacing. Running the PNGs through an optimiser such as oxipng or
// pngcrush will change the row filters and make --check fail even though the
// pixels are identical. Regenerate with this script instead.
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';

const BG = [0x0b, 0x0f, 0x14];
const BARS = [
  { w: 0.625, c: [0xe2, 0xe8, 0xf0] },
  { w: 0.47, c: [0x7d, 0xd3, 0xfc] },
  { w: 0.31, c: [0x38, 0xbd, 0xf8] },
];

const crcTable = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * Signed distance to a rounded rectangle, used to antialias every edge.
 * Math.sqrt rather than Math.hypot: hypot is only required to be
 * implementation-approximated, so it may differ in the last bit between
 * engines and move an antialiased pixel. sqrt is exactly specified.
 */
const roundRectSdf = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
};

const blend = (dst, i, rgb, a) => {
  for (let k = 0; k < 3; k++) dst[i + k] = Math.round(dst[i + k] * (1 - a) + rgb[k] * a);
};

/**
 * @param maskable Launchers crop a maskable icon to their own shape, so it is
 * drawn full-bleed with the artwork pulled into the inner 80% safe zone.
 * Reusing the rounded "any" icon would show its transparent corners.
 */
function render(size, maskable = false) {
  const px = new Uint8Array(size * size * 4);
  const panelR = maskable ? 0 : size * 0.219;
  const art = maskable ? 0.72 : 1;
  const barH = size * 0.09 * art;
  const barR = barH / 2;
  const gap = size * 0.071 * art;
  const totalH = BARS.length * barH + (BARS.length - 1) * gap;
  const top = (size - totalH) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;
      const panel = roundRectSdf(cx, cy, size / 2, size / 2, size / 2, size / 2, panelR);
      const panelA = Math.min(Math.max(0.5 - panel, 0), 1);
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = Math.round(panelA * 255);
      if (panelA > 0) blend(px, i, BG, 1);

      BARS.forEach((bar, n) => {
        const bw = size * bar.w * art;
        const byc = top + n * (barH + gap) + barH / 2;
        const d = roundRectSdf(cx, cy, size / 2, byc, bw / 2, barH / 2, barR);
        const a = Math.min(Math.max(0.5 - d, 0), 1) * panelA;
        if (a > 0) blend(px, i, bar.c, a);
      });
    }
  }
  return px;
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes only what this script writes: 8-bit RGBA, filter 0 on every row. */
function decodePng(buffer) {
  let i = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (i + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.toString('ascii', i + 4, i + 8);
    const data = buffer.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('unexpected PNG format');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unexpected PNG row filter');
    pixels.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, pixels };
}

const TARGETS = [
  { file: 'public/icon-192.png', size: 192, maskable: false },
  { file: 'public/icon-512.png', size: 512, maskable: false },
  { file: 'public/icon-maskable-512.png', size: 512, maskable: true },
];

const checking = process.argv.includes('--check');
let failures = 0;

for (const { file, size, maskable } of TARGETS) {
  const pixels = render(size, maskable);
  if (!checking) {
    writeFileSync(file, encodePng(size, pixels));
    console.log('wrote', file);
    continue;
  }
  try {
    const decoded = decodePng(readFileSync(file));
    const same =
      decoded.width === size &&
      decoded.height === size &&
      decoded.pixels.length === pixels.length &&
      decoded.pixels.every((value, index) => value === pixels[index]);
    console.log(`${same ? 'ok  ' : 'FAIL'} ${file}`);
    if (!same) failures += 1;
  } catch (error) {
    console.log(`FAIL ${file}: ${error.message}`);
    failures += 1;
  }
}

if (checking) {
  console.log(failures === 0 ? '\nicons match the generator' : `\n${failures} icon(s) out of date`);
  process.exit(failures === 0 ? 0 : 1);
}
