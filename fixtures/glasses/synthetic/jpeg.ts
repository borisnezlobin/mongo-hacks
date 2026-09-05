/**
 * A baseline grayscale JPEG encoder, small enough to live beside the fixture.
 *
 * The synthetic capture has to be regenerable from a clean checkout with
 * nothing but Bun, so it cannot reach for ImageMagick or a transitive npm
 * dependency that happens to be installed today. Baseline JPEG with the Annex K
 * tables is about a hundred lines of arithmetic and every decoder in the
 * pipeline — the app, OpenCV in the sidecar, `magick identify` — reads it.
 *
 * Grayscale rather than colour because the fixture is a shape test, and one
 * component halves the code without changing what any consumer sees.
 */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const LUMINANCE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

interface Code {
  readonly length: number;
  readonly code: number;
}

function huffmanTable(bits: readonly number[], values: readonly number[]): Map<number, Code> {
  const table = new Map<number, Code>();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let count = 0; count < (bits[length - 1] as number); count += 1) {
      table.set(values[index] as number, { length, code });
      index += 1;
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

const DC_TABLE = huffmanTable(DC_BITS, DC_VALUES);
const AC_TABLE = huffmanTable(AC_BITS, AC_VALUES);

const COSINES = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      table[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

/** Naive separable DCT-II. The images are a few hundred blocks; clarity wins. */
function forwardDct(block: Float64Array): Float64Array {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          sum += (block[y * 8 + x] as number) * (COSINES[u * 8 + x] as number) * (COSINES[v * 8 + y] as number);
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      out[v * 8 + u] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/** How many bits a coefficient needs, which is also its Huffman category. */
function categoryOf(value: number): number {
  let magnitude = Math.abs(value);
  let bits = 0;
  while (magnitude > 0) {
    magnitude >>= 1;
    bits += 1;
  }
  return bits;
}

class BitWriter {
  private readonly bytes: number[] = [];
  private accumulator = 0;
  private filled = 0;

  push(code: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.accumulator = (this.accumulator << 1) | ((code >> bit) & 1);
      this.filled += 1;
      if (this.filled === 8) this.emitByte();
    }
  }

  /** Pad with ones, as the standard requires, so the decoder stops cleanly. */
  finish(): number[] {
    while (this.filled !== 0) {
      this.accumulator = (this.accumulator << 1) | 1;
      this.filled += 1;
      if (this.filled === 8) this.emitByte();
    }
    return this.bytes;
  }

  private emitByte(): void {
    const byte = this.accumulator & 0xff;
    this.bytes.push(byte);
    // 0xFF starts a marker, so a literal 0xFF in the entropy stream is stuffed.
    if (byte === 0xff) this.bytes.push(0x00);
    this.accumulator = 0;
    this.filled = 0;
  }
}

function writeCoefficient(writer: BitWriter, value: number, category: number): void {
  const encoded = value >= 0 ? value : value + (1 << category) - 1;
  writer.push(encoded, category);
}

function encodeBlock(writer: BitWriter, quantized: Int32Array, previousDc: number): number {
  const dcDiff = (quantized[0] as number) - previousDc;
  const dcCategory = categoryOf(dcDiff);
  const dcCode = DC_TABLE.get(dcCategory) as Code;
  writer.push(dcCode.code, dcCode.length);
  if (dcCategory > 0) writeCoefficient(writer, dcDiff, dcCategory);

  let run = 0;
  for (let index = 1; index < 64; index += 1) {
    const value = quantized[index] as number;
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      const sixteenZeros = AC_TABLE.get(0xf0) as Code;
      writer.push(sixteenZeros.code, sixteenZeros.length);
      run -= 16;
    }
    const category = categoryOf(value);
    const symbol = AC_TABLE.get((run << 4) | category) as Code;
    writer.push(symbol.code, symbol.length);
    writeCoefficient(writer, value, category);
    run = 0;
  }
  if (run > 0) {
    const endOfBlock = AC_TABLE.get(0x00) as Code;
    writer.push(endOfBlock.code, endOfBlock.length);
  }
  return quantized[0] as number;
}

function quantizeInto(coefficients: Float64Array, quantTable: Int32Array): Int32Array {
  const out = new Int32Array(64);
  for (let index = 0; index < 64; index += 1) {
    const natural = ZIGZAG[index] as number;
    out[index] = Math.round((coefficients[natural] as number) / (quantTable[natural] as number));
  }
  return out;
}

/** Annex K scaling: quality 50 is the table as printed. */
function scaledQuantTable(quality: number): Int32Array {
  const clamped = Math.min(100, Math.max(1, Math.round(quality)));
  const factor = clamped < 50 ? 5000 / clamped : 200 - clamped * 2;
  const table = new Int32Array(64);
  for (let index = 0; index < 64; index += 1) {
    const scaled = Math.floor(((LUMINANCE_QUANT[index] as number) * factor + 50) / 100);
    table[index] = Math.min(255, Math.max(1, scaled));
  }
  return table;
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
}

function quantSegment(table: Int32Array): number[] {
  const payload = [0x00];
  for (let index = 0; index < 64; index += 1) payload.push(table[ZIGZAG[index] as number] as number);
  return segment(0xdb, payload);
}

function huffmanSegment(id: number, bits: readonly number[], values: readonly number[]): number[] {
  return segment(0xc4, [id, ...bits, ...values]);
}

function frameSegment(width: number, height: number): number[] {
  return segment(0xc0, [
    8,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    1, 1, 0x11, 0,
  ]);
}

function blockAt(gray: Uint8Array, width: number, height: number, originX: number, originY: number): Float64Array {
  const block = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) {
    const sourceY = Math.min(height - 1, originY + y);
    for (let x = 0; x < 8; x += 1) {
      const sourceX = Math.min(width - 1, originX + x);
      block[y * 8 + x] = (gray[sourceY * width + sourceX] as number) - 128;
    }
  }
  return block;
}

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, row major. */
  pixels: Uint8Array;
}

/** Baseline sequential JPEG, one component, standard Huffman tables. */
export function encodeGrayJpeg(image: GrayImage, quality = 80): Uint8Array {
  const quantTable = scaledQuantTable(quality);
  const writer = new BitWriter();
  let previousDc = 0;
  for (let originY = 0; originY < image.height; originY += 8) {
    for (let originX = 0; originX < image.width; originX += 8) {
      const block = blockAt(image.pixels, image.width, image.height, originX, originY);
      const quantized = quantizeInto(forwardDct(block), quantTable);
      previousDc = encodeBlock(writer, quantized, previousDc);
    }
  }

  const bytes = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...quantSegment(quantTable),
    ...frameSegment(image.width, image.height),
    ...huffmanSegment(0x00, DC_BITS, DC_VALUES),
    ...huffmanSegment(0x10, AC_BITS, AC_VALUES),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...writer.finish(),
    0xff, 0xd9,
  ];
  return Uint8Array.from(bytes);
}
