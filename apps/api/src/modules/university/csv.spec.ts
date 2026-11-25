import { parseBool, parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads plain rows with LF and CRLF and ignores blank lines', () => {
    expect(parseCsv('a,b\r\n1,2\n\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
  });
  it('strips a UTF-8 BOM and keeps empty fields', () => {
    expect(parseCsv('﻿a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });
  it('rejects an unterminated quote instead of swallowing the rest of the file', () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(/Unterminated/);
  });
  it('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseBool', () => {
  it('accepts the usual spellings and refuses anything else', () => {
    for (const t of ['true', 'YES', ' y ', '1']) expect(parseBool(t)).toBe(true);
    for (const f of ['false', 'No', 'n', '0']) expect(parseBool(f)).toBe(false);
    for (const x of ['', 'maybe', '2']) expect(parseBool(x)).toBeUndefined();
  });
});
