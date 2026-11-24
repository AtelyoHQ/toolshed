import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  degrees,
  type PDFObject,
  type PDFRef,
} from '@cantoo/pdf-lib';
import { deflateSync } from 'node:zlib';

/**
 * Documents to run the PDF engine against, built in memory.
 *
 * Test support for `src/lib/pdf/*.test.ts`, not part of the engine. Nothing is
 * read from disk: a fixture that lives in a file drifts from what the tests
 * claim about it, and a repository of binary PDFs is impossible to review.
 *
 * The images here are *headers*, not pictures. pdf-lib reads a JPEG's size
 * from its start-of-frame marker and a PNG's from its IHDR, and never decodes
 * either, so a valid header with filler where the scan data belongs is enough
 * to embed — and it keeps the fixtures small enough to read.
 */

export interface PageSpec {
  width: number;
  height: number;
  /** Degrees; must be a quarter turn. */
  rotate?: number;
  text?: string;
  /**
   * Moves the page's box away from the origin, the way a cropped scan or
   * anything through pdfcrop arrives.
   */
  offset?: { x: number; y: number };
}

/**
 * A document with one page per spec.
 *
 * Give the pages different widths when a test needs to know which page ended
 * up where: page size survives copying, reordering and rotation, so it works
 * as a label that the operation under test cannot accidentally fake.
 */
export async function buildPdf(pages: readonly PageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of pages) {
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.text) page.drawText(spec.text, { x: 10, y: 10, size: 12, font });
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.offset) {
      page.setMediaBox(spec.offset.x, spec.offset.y, spec.width, spec.height);
      page.setCropBox(spec.offset.x, spec.offset.y, spec.width, spec.height);
    }
  }

  return doc.save({ useObjectStreams: true });
}

/**
 * A document carrying metadata the way real ones do: an information
 * dictionary, an XMP packet on the catalog, a second packet on the page, and
 * an application's private data.
 *
 * The packets matter. Everything a mainstream tool produces has one, it holds
 * a second copy of the author and the producing application, and emptying the
 * information dictionary does nothing about it.
 */
export async function buildPdfWithMetadata(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  doc.setTitle('Quarterly figures');
  doc.setAuthor('A Person');
  doc.setProducer('Some Application 4.2');
  doc.setCreationDate(new Date('2020-01-01T00:00:00Z'));

  const { context } = doc;

  // Something the page uses *and* the metadata names, with a subtree of its
  // own: a font works like this — kept because the page uses it, with an
  // indirect descriptor which itself points at the embedded font file. Both
  // have to survive, or the kept object is left pointing at nothing.
  const sharedGrandchild = context.register(context.stream('%shared grandchild marker'));
  const sharedChild = context.register(
    context.obj({ Type: 'FontDescriptor', FontFile: sharedGrandchild }),
  );
  const shared = context.register(
    context.stream('%shared marker', { Type: 'ExtGState', ca: 0.5, Child: sharedChild }),
  );

  doc.catalog.set(
    PDFName.of('Metadata'),
    context.register(
      context.stream(
        `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">` +
          `<dc:creator>A Person</dc:creator><xmp:CreatorTool>Some Application 4.2</xmp:CreatorTool>` +
          `</x:xmpmeta><?xpacket end="w"?>`,
        { Type: 'Metadata', Subtype: 'XML', SharedByMistake: shared },
      ),
    ),
  );
  page.node.set(
    PDFName.of('Metadata'),
    context.register(
      context.stream('<x:xmpmeta><dc:title>Page level secret</dc:title></x:xmpmeta>', {
        Type: 'Metadata',
        Subtype: 'XML',
      }),
    ),
  );

  // The shape the specification describes: a direct dictionary per
  // application, each holding its own indirect `/Private` stream. The data is
  // two levels down, which is where an implementation that follows one
  // reference stops looking.
  page.node.set(
    PDFName.of('PieceInfo'),
    context.obj({
      SomeApplication: {
        LastModified: PDFString.fromDate(new Date('2020-01-02T00:00:00Z')),
        Private: context.register(
          context.stream('originally /tmp/draft-of-Quarterly-figures.docx'),
        ),
      },
    }),
  );
  // Indirect, where the page's is direct, and with the payload one level
  // deeper still: this is the shape Illustrator writes — a reference to a
  // dictionary per application, each holding a `/Private` *dictionary* of
  // streams. Both shapes are legal, and an implementation that follows only
  // one of them, or stops after a fixed number of levels, leaks through the
  // other.
  doc.catalog.set(
    PDFName.of('PieceInfo'),
    context.register(
      context.obj({
        SomeApplication: {
          LastModified: PDFString.fromDate(new Date('2020-01-03T00:00:00Z')),
          Private: {
            PrivateData: context.register(context.stream('catalog level secret')),
            ContainerVersion: 11,
          },
        },
      }),
    ),
  );

  // Metadata hangs off anything, not only the catalog and the pages.
  const image = context.register(
    context.stream(tinyJpeg({ size: 200 }), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 40,
      Height: 20,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'DCTDecode',
      Metadata: context.register(
        context.stream('<x:xmpmeta><dc:creator>Photographer</dc:creator></x:xmpmeta>', {
          Type: 'Metadata',
          Subtype: 'XML',
        }),
      ),
    }),
  );
  page.node.set(
    PDFName.of('Resources'),
    context.obj({ XObject: context.obj({ Im0: image }), ExtGState: context.obj({ GS0: shared }) }),
  );

  return doc.save({ useObjectStreams: true });
}

export interface EncryptedPdfOptions {
  userPassword?: string;
  ownerPassword?: string;
  pages?: readonly PageSpec[];
  /**
   * RC4-128 instead of AES-256. Broken, and what Word and pre-2005 Acrobat
   * wrote, so documents in the wild still arrive this way.
   */
  weak?: boolean;
}

export async function buildEncryptedPdf(options: EncryptedPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of options.pages ?? [{ width: 200, height: 300 }]) {
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.text) page.drawText(spec.text, { x: 10, y: 10, size: 12, font });
  }
  doc.encrypt({
    ...(options.userPassword ? { userPassword: options.userPassword } : {}),
    ...(options.ownerPassword ? { ownerPassword: options.ownerPassword } : {}),
    ...(options.weak
      ? { algorithm: 'RC4-128' as const, allowWeakCryptography: true }
      : { algorithm: 'AES-256' as const }),
  });
  return doc.save();
}

/**
 * The resolution `buildHairlinePdf`'s positions are calculated for.
 *
 * Exported so that the test using the fixture cannot change the resolution
 * without changing this: at 150 dpi the same two rules land on rows 16 to 18
 * and 67 to 69, and row 16 is on the stride — the strided pass would find
 * them, the exact scan would never run, and the test would pass while proving
 * nothing.
 */
export const HAIRLINE_DPI = 96;

/**
 * One page whose only marks are two hairline rules.
 *
 * Both positions are deliberate. At `HAIRLINE_DPI` a 300 pt page is 400 px, so
 * 8.25 pt and 33 pt from the top are pixel rows 11 and 44, and a 0.9 pt rule
 * covers two rows each: 10 and 11, 43 and 44. No multiple of eight is among
 * them, so a renderer that samples every eighth row cannot see this page at
 * all.
 *
 * Two rules rather than one because this page names no font and no XObject, so
 * the only thing making it count as "a document with something on it" is the
 * length of its content stream, and one rule lands within a few bytes of the
 * threshold. Two puts it clear of it, so a change to how pdf-lib writes line
 * operators cannot quietly turn the test that uses this into one that passes
 * for the wrong reason.
 */
export async function buildHairlinePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  for (const y of [291.75, 267]) {
    page.drawLine({ start: { x: 20, y }, end: { x: 280, y }, thickness: 0.9 });
  }
  return doc.save({ useObjectStreams: true });
}

/**
 * A page that paints one full-page image and nothing else: a scan.
 *
 * Its content stream is thirty bytes, which is the point. Anything that
 * decides "this document had something on it" by the size of a content stream
 * reports this page as empty, and a scan is the document rasterising
 * compression exists for.
 */
export async function buildScanPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;

  const image = context.register(
    context.stream(tinyJpeg({ width: 1700, height: 2200, size: 4096 }), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1700,
      Height: 2200,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'DCTDecode',
    }),
  );
  page.node.set(PDFName.of('Resources'), context.obj({ XObject: context.obj({ Im0: image }) }));
  page.node.set(
    PDFName.of('Contents'),
    context.register(context.stream('q 612 0 0 792 0 0 cm /Im0 Do Q')),
  );

  return doc.save({ useObjectStreams: true });
}

/**
 * A document whose text is set in a CJK font that is not embedded and has no
 * `/ToUnicode` map — what Word and Acrobat write for Japanese, Chinese and
 * Korean text.
 *
 * pdf.js cannot draw or read a word of this without the predefined character
 * maps: it builds the Unicode map from `<registry>-<ordering>-UCS2.bcmap`,
 * and if that is not there the font fails to translate, becomes an error font
 * that maps every character to nothing, and the page comes out blank. The
 * `Identity` ordering is the control — pdf.js needs no map for that one — so
 * a test can tell "the maps are missing" from "this fixture draws nothing".
 */
export async function buildCjkPdf(
  ordering: 'Japan1' | 'GB1' | 'CNS1' | 'Korea1' | 'Identity' = 'Japan1',
  lines = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([240, 40 + lines * 24]);
  const { context } = doc;

  const descriptor = context.register(
    context.obj({
      Type: 'FontDescriptor',
      FontName: PDFName.of('KozMinPro-Regular'),
      Flags: 4,
      FontBBox: context.obj([0, -120, 1000, 880]),
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -120,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const descendant = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType0',
      BaseFont: PDFName.of('KozMinPro-Regular'),
      CIDSystemInfo: context.obj({
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of(ordering),
        Supplement: PDFNumber.of(6),
      }),
      FontDescriptor: descriptor,
      DW: 1000,
    }),
  );
  const font = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: PDFName.of('KozMinPro-Regular'),
      Encoding: PDFName.of('Identity-H'),
      DescendantFonts: context.obj([descendant]),
    }),
  );
  page.node.set(PDFName.of('Resources'), context.obj({ Font: context.obj({ F1: font }) }));

  const rows = Array.from(
    { length: lines },
    (_unused, index) => `BT /F1 18 Tf 12 ${12 + index * 24} Td <0A440A450A460A47> Tj ET`,
  );
  page.node.set(PDFName.of('Contents'), context.register(context.stream(rows.join('\n'))));

  return doc.save({ useObjectStreams: true });
}

/** A JPEG header with a valid start-of-frame and filler for the scan. */
export function tinyJpeg(
  options: { width?: number; height?: number; components?: number; size?: number } = {},
): Uint8Array {
  const width = options.width ?? 40;
  const height = options.height ?? 20;
  const components = options.components ?? 3;

  const sof = [
    0xff,
    0xc0,
    0x00,
    8 + 3 * components,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
  ];
  for (let channel = 1; channel <= components; channel++) {
    sof.push(channel, 0x11, channel === 1 ? 0x00 : 0x01);
  }
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];

  const head = [0xff, 0xd8, ...sof, ...sos];
  const filler = Math.max(0, (options.size ?? 8192) - head.length - 2);
  return new Uint8Array([...head, ...new Array<number>(filler).fill(0x55), 0xff, 0xd9]);
}

/**
 * The same, with an EXIF segment carrying a location and a serial number.
 *
 * What a camera file actually looks like, and the reason images-to-PDF strips
 * before it embeds.
 */
export function tinyJpegWithExif(text = 'GPSLatitude 51.5074 CAMERA-SERIAL-123'): Uint8Array {
  const jpeg = tinyJpeg({ size: 2048 });
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...[...text].map((c) => c.charCodeAt(0))];
  const length = payload.length + 2;
  const segment = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload];

  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** A real, decodable PNG: deflate comes from Node, so the IDAT is genuine. */
export function tinyPng(width = 10, height = 6): Uint8Array {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter type for the row
    for (let x = 0; x < width; x++) raw.push(200, 100, 50);
  }
  const header = [...be32(width), ...be32(height), 8, 2, 0, 0, 0];
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk('IHDR', header),
    ...pngChunk('IDAT', [...deflateSync(Buffer.from(raw))]),
    ...pngChunk('IEND', []),
  ]);
}

export interface ImageXObjectSpec {
  bytes: Uint8Array;
  width?: number;
  height?: number;
  /** A name (`DeviceRGB`), or `['ICCBased', components]`. */
  colorSpace?: string | ['ICCBased', number];
  /** Writes the colour space as an indirect reference, which is legal. */
  indirectColorSpace?: boolean;
  /** Defaults to `DCTDecode`. An array value becomes a filter chain. */
  filter?: string | string[];
  decode?: number[];
}

/**
 * A one-page document holding image XObjects described entry by entry.
 *
 * Built at the dictionary level rather than through `embedJpg`, because the
 * cases that matter to the compressor are the ones pdf-lib would never
 * produce: a CMYK photograph, an inverted scan with a `/Decode` array, a JPEG
 * inside a filter chain.
 */
export async function buildPdfWithImageXObjects(
  specs: readonly ImageXObjectSpec[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  const { context } = doc;

  const resources: Record<string, PDFRef> = {};
  for (const [index, spec] of specs.entries()) {
    const stream = context.stream(spec.bytes, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: spec.width ?? 40,
      Height: spec.height ?? 20,
      BitsPerComponent: 8,
      Filter: filterFor(spec.filter ?? 'DCTDecode', context),
      ColorSpace: spec.indirectColorSpace
        ? context.register(colourSpaceFor(spec.colorSpace ?? 'DeviceRGB', context))
        : colourSpaceFor(spec.colorSpace ?? 'DeviceRGB', context),
      ...(spec.decode ? { Decode: context.obj(spec.decode) } : {}),
    });
    resources[`Im${index}`] = context.register(stream);
  }

  page.node.set(PDFName.of('Resources'), context.obj({ XObject: context.obj(resources) }));
  return doc.save({ useObjectStreams: true });
}

/** Every content stream of a page, decoded and concatenated as Latin-1 text. */
export async function pageOperators(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const contents = page.node.lookup(PDFName.of('Contents'));

  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) streams.push(contents);
  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index++) {
      const entry = doc.context.lookup(contents.get(index));
      if (entry instanceof PDFRawStream) streams.push(entry);
    }
  }

  return streams
    .map((stream) => {
      const raw = stream.dict.has(PDFName.of('Filter'))
        ? decodePDFRawStream(stream).decode()
        : stream.getContents();
      return latin1(raw);
    })
    .join('\n');
}

/**
 * The text a page actually draws, decoded.
 *
 * pdf-lib writes text for the built-in fonts as a hex string — `<44524146 54>
 * Tj` rather than `(DRAFT) Tj` — so a test that looks for the words it asked
 * for has to undo that first.
 */
export async function drawnText(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const operators = await pageOperators(bytes, pageIndex);
  const strings = /<([0-9a-fA-F\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;

  let text = '';
  for (const match of operators.matchAll(strings)) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, '');
      for (let at = 0; at + 1 < hex.length; at += 2) {
        text += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2), 16));
      }
    } else if (match[2] !== undefined) {
      text += match[2].replace(/\\([\\()])/g, '$1');
    }
    text += '\n';
  }
  return text;
}

/**
 * Everything a saved document actually contains, decompressed.
 *
 * Grepping the raw bytes is not enough and neither is asking pdf-lib: a
 * document's information dictionary ends up inside a compressed object stream,
 * where the first oracle cannot see it, and `getAuthor()` reads the trailer,
 * so the second reports it gone while it sits in the file. Between them they
 * let a whole Info dictionary through. This decodes every stream and
 * stringifies every other object, which is the only honest way to ask whether
 * something was really removed.
 */
export async function everythingIn(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const parts = [latin1(bytes)];

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      try {
        parts.push(latin1(decodePDFRawStream(object).decode()));
      } catch {
        parts.push(latin1(object.getContents()));
      }
      parts.push(object.dict.toString());
      continue;
    }
    parts.push(object.toString());
  }
  return parts.join('\n');
}

export function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function filterFor(filter: string | string[], context: PDFDocument['context']): PDFObject {
  return Array.isArray(filter) ? context.obj(filter) : context.obj(filter);
}

function colourSpaceFor(
  space: string | ['ICCBased', number],
  context: PDFDocument['context'],
): PDFObject {
  if (typeof space === 'string') return context.obj(space);
  const profile = context.register(
    context.stream(new Uint8Array([0x00, 0x01, 0x02, 0x03]), { N: space[1] }),
  );
  return context.obj(['ICCBased', profile]);
}

function pngChunk(type: string, data: readonly number[]): number[] {
  const body = [...[...type].map((character) => character.charCodeAt(0)), ...data];
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function crc32(bytes: readonly number[]): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
