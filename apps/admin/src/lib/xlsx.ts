import { strFromU8, unzipSync, type Unzipped } from 'fflate';

/**
 * Reads the FIRST worksheet of an .xlsx file and returns it as CSV text, entirely in the browser. The server therefore
 * only ever sees CSV (its parser, limits, preview and checksum are unchanged) and never opens a spreadsheet container.
 * Deliberately small: values only. Formulas use their cached result, dates stay as the serial numbers Excel stores
 * (the import datasets contain none), and macros, styles, charts and other sheets are ignored.
 */
export const MAX_XLSX_BYTES = 200 * 1024;
const MAX_UNZIPPED_BYTES = 8 * 1024 * 1024; // zip-bomb guard: refuse before inflating anything larger

export class XlsxError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');

/** "AB12" -> zero-based column 27 */
const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] ?? '') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function readAll(bytes: Uint8Array): Unzipped {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError('This is not an .xlsx file. Save it as "Excel Workbook (.xlsx)" or as CSV.');
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!/^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_UNZIPPED_BYTES || total > MAX_UNZIPPED_BYTES) throw new XlsxError('This spreadsheet expands to far more data than an import file should hold.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError('This file could not be read as an .xlsx workbook.');
  }
}

export function xlsxToCsv(bytes: Uint8Array): string {
  const files = readAll(bytes);
  const get = (name: string) => (files[name] ? strFromU8(files[name]!) : null);

  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new XlsxError('This workbook has no sheets.');
  const firstSheet = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const rid = firstSheet && /r:id="([^"]+)"/.exec(firstSheet)?.[1];
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  let target = rid ? [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => new RegExp(`\\bId="${rid}"`).test(r)) : undefined;
  let path = target && /Target="([^"]+)"/.exec(target)?.[1];
  path = path ? (path.startsWith('/') ? path.slice(1) : `xl/${path}`) : 'xl/worksheets/sheet1.xml';
  const sheet = get(path) ?? get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new XlsxError('The first sheet could not be found in this workbook.');

  const shared = (get('xl/sharedStrings.xml') ?? '') ? [...(get('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!)) : [];

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!, inner = cm[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 'inlineStr') value = textOf(inner);
      else if (raw !== undefined) {
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw.trim() === '1' ? 'true' : 'false';
        else value = decode(raw).trim();
      }
      const at = ref ? colIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) throw new XlsxError('The first sheet is empty.');
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => csvCell(r[i] ?? '')).join(',')).join('\r\n') + '\r\n';
}
