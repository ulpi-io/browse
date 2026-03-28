/**
 * Self-contained PNG decoder, encoder + pixel comparator.
 * No external deps — uses only zlib (Node/Bun built-in).
 * Works in both dev mode (bun run) and compiled binary ($bunfs).
 *
 * Decoder supports: 8-bit RGB (color type 2) and RGBA (color type 6).
 * Handles all 5 PNG scanline filter types (None/Sub/Up/Average/Paeth).
 * Encoder outputs: 8-bit RGBA (color type 6), filter None, zlib-compressed.
 */

import * as zlib from 'zlib';

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export interface DecodedImage {
  width: number;
  height: number;
  data: Buffer; // RGBA pixels
}

export interface CompareResult {
  totalPixels: number;
  diffPixels: number;
  mismatchPct: number;
  passed: boolean;
  diffImage?: Buffer;
}

export function decodePNG(buf: Buffer): DecodedImage {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_MAGIC[i]) throw new Error('Not a valid PNG file');
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth} (only 8-bit supported)`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType} (only RGB=2 and RGBA=6 supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;

  // Collect IDAT chunks
  const idats: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idats.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idats));
  const pixels = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const scanline = Buffer.from(raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? scanline[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;

      switch (filterType) {
        case 0: break;
        case 1: scanline[x] = (scanline[x] + a) & 0xff; break;
        case 2: scanline[x] = (scanline[x] + b) & 0xff; break;
        case 3: scanline[x] = (scanline[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          scanline[x] = (scanline[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`Unknown PNG filter type: ${filterType}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = scanline[si];
      pixels[di + 1] = scanline[si + 1];
      pixels[di + 2] = scanline[si + 2];
      pixels[di + 3] = channels === 4 ? scanline[si + 3] : 255;
    }

    scanline.copy(prev);
  }

  return { width, height, data: pixels };
}

/**
 * Encode a DecodedImage (RGBA pixels) into a PNG buffer.
 * Uses filter type None (0) for simplicity — zlib handles compression.
 */
export function encodePNG(img: DecodedImage): Buffer {
  // Helper: write a PNG chunk (length + type + data + CRC32)
  function writeChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    // CRC32 covers type + data
    const crcData = chunk.slice(4, 8 + data.length);
    chunk.writeUInt32BE(zlib.crc32(crcData) >>> 0, 8 + data.length);
    return chunk;
  }

  // PNG signature
  const signature = Buffer.from(PNG_MAGIC);

  // IHDR: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression method
  ihdr[11] = 0;  // filter method
  ihdr[12] = 0;  // no interlace

  // IDAT: for each scanline, prepend filter byte 0 (None), then raw RGBA pixels
  const rawStride = img.width * 4;
  const rawData = Buffer.alloc(img.height * (1 + rawStride));
  for (let y = 0; y < img.height; y++) {
    const outOff = y * (1 + rawStride);
    rawData[outOff] = 0; // filter type: None
    img.data.copy(rawData, outOff + 1, y * rawStride, (y + 1) * rawStride);
  }
  const compressed = zlib.deflateSync(rawData);

  // IEND: empty chunk
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', iend),
  ]);
}

/**
 * Generate a visual diff image highlighting pixel differences.
 * - Pixels only in one image (size mismatch): bright red (255,0,0,255)
 * - Pixels differing beyond threshold: red-tinted (255, g/3, b/3, 255)
 * - Pixels matching: dimmed (r/3, g/3, b/3, 128)
 */
export function generateDiffImage(base: DecodedImage, curr: DecodedImage, colorThreshold: number): Buffer {
  const w = Math.max(base.width, curr.width);
  const h = Math.max(base.height, curr.height);
  const diffData = Buffer.alloc(w * h * 4);
  const colorThreshSq = colorThreshold * colorThreshold * 3;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      const inBase = x < base.width && y < base.height;
      const inCurr = x < curr.width && y < curr.height;

      if (!inBase || !inCurr) {
        // Size mismatch — bright red
        diffData[di] = 255;
        diffData[di + 1] = 0;
        diffData[di + 2] = 0;
        diffData[di + 3] = 255;
        continue;
      }

      const bi = (y * base.width + x) * 4;
      const ci = (y * curr.width + x) * 4;
      const dr = base.data[bi] - curr.data[ci];
      const dg = base.data[bi + 1] - curr.data[ci + 1];
      const db = base.data[bi + 2] - curr.data[ci + 2];
      const distSq = dr * dr + dg * dg + db * db;
      const isDiff = colorThreshold === 0 ? distSq > 0 : distSq > colorThreshSq;

      if (isDiff) {
        // Different — red-tinted using current image colors
        diffData[di] = 255;
        diffData[di + 1] = (curr.data[ci + 1] / 3) | 0;
        diffData[di + 2] = (curr.data[ci + 2] / 3) | 0;
        diffData[di + 3] = 255;
      } else {
        // Matching — dimmed
        diffData[di] = (curr.data[ci] / 3) | 0;
        diffData[di + 1] = (curr.data[ci + 1] / 3) | 0;
        diffData[di + 2] = (curr.data[ci + 2] / 3) | 0;
        diffData[di + 3] = 128;
      }
    }
  }

  return encodePNG({ width: w, height: h, data: diffData });
}

export function compareScreenshots(
  baselineBuf: Buffer,
  currentBuf: Buffer,
  thresholdPct: number = 0.1,
  colorThreshold: number = 30,
): CompareResult {
  const base = decodePNG(baselineBuf);
  const curr = decodePNG(currentBuf);

  const w = Math.max(base.width, curr.width);
  const h = Math.max(base.height, curr.height);
  const totalPixels = w * h;
  let diffPixels = 0;
  // Squared color distance threshold. 0 = exact match (any difference counts).
  const colorThreshSq = colorThreshold * colorThreshold * 3; // across R,G,B channels

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBase = x < base.width && y < base.height;
      const inCurr = x < curr.width && y < curr.height;
      if (!inBase || !inCurr) { diffPixels++; continue; }

      const bi = (y * base.width + x) * 4;
      const ci = (y * curr.width + x) * 4;
      const dr = base.data[bi] - curr.data[ci];
      const dg = base.data[bi + 1] - curr.data[ci + 1];
      const db = base.data[bi + 2] - curr.data[ci + 2];
      const distSq = dr * dr + dg * dg + db * db;
      if (colorThreshold === 0 ? distSq > 0 : distSq > colorThreshSq) diffPixels++;
    }
  }

  const mismatchPct = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;
  const passed = mismatchPct <= thresholdPct;
  const result: CompareResult = { totalPixels, diffPixels, mismatchPct, passed };

  if (!passed) {
    result.diffImage = generateDiffImage(base, curr, colorThreshold);
  }

  return result;
}
