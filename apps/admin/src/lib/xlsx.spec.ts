import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { XlsxError, xlsxToCsv } from './xlsx';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function workbook(sheet: string, shared: string[] = [], extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${NS}><sheetData>${sheet}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>`),
  };
  if (shared.length) files['xl/sharedStrings.xml'] = strToU8(`<sst ${NS}>${shared.map((s) => `<si>${s}</si>`).join('')}</sst>`);
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

describe('xlsxToCsv (browser-side conversion, server only ever sees CSV)', () => {
  it('reads shared strings, numbers, booleans and inline strings from the first sheet only', () => {
    const csv = xlsxToCsv(workbook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>2026-BCS-0001</t></is></c><c r="B2"><v>85.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>100</v></c><c r="C3" t="b"><v>0</v></c></row>',
      ['reg_no', 'fees_paid_percent', 'exam_cleared', '2026-BIT-0002'].map((s) => `<t>${s}</t>`),
    ));
    expect(csv).toBe('reg_no,fees_paid_percent,exam_cleared\r\n2026-BCS-0001,85.5,true\r\n2026-BIT-0002,100,false\r\n');
    expect(csv).not.toContain('wrong sheet');
  });

  it('keeps blank cells in place, decodes entities, joins rich text and quotes commas and quotes', () => {
    const csv = xlsxToCsv(workbook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row><row r="2"><c r="B2"><v>7</v></c><c r="C2" t="s"><v>2</v></c></row>',
      ['<t>a &amp; b</t>', '<r><t>say </t></r><r><t>"hi", ok</t></r>', '<t>&#65;&lt;</t>'],
    ));
    expect(csv).toBe('a & b,,,"say ""hi"", ok"\r\n,7,A<,\r\n');
  });

  it('uses the cached value of formula cells', () => {
    const csv = xlsxToCsv(workbook('<row r="1"><c r="A1"><f>SUM(1,2)</f><v>3</v></c><c r="B1" t="str"><f>"x"&amp;"y"</f><v>xy</v></c></row>'));
    expect(csv).toBe('3,xy\r\n');
  });

  it('refuses things that are not a usable workbook', () => {
    expect(() => xlsxToCsv(new TextEncoder().encode('reg_no,fine_ugx\n1,2'))).toThrow(XlsxError);
    expect(() => xlsxToCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(XlsxError);
    expect(() => xlsxToCsv(zipSync({ 'readme.txt': strToU8('hello') }))).toThrow(/no sheets/);
    expect(() => xlsxToCsv(workbook(''))).toThrow(/empty/);
  });

  it('refuses a workbook that would inflate far beyond an import file (zip bomb)', () => {
    const big = 'A'.repeat(9 * 1024 * 1024);
    const bomb = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8(big) });
    expect(bomb.length).toBeLessThan(200 * 1024); // tiny on the wire, huge when inflated
    expect(() => xlsxToCsv(bomb)).toThrow(/far more data/);
  });
});
