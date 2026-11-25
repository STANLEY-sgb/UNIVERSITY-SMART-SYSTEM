import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { decodeQr } from './qr-decode';

/** Renders a QR to an RGBA bitmap, as a camera frame would deliver it, without needing a DOM. */
function bitmap(text: string, scale = 6, margin = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

describe('QR decoding (the scanner path without a camera)', () => {
  it('decodes a real KIU1-shaped token rendered as a QR image', () => {
    const token = `KIU1.${'A'.repeat(120)}.${'B'.repeat(86)}`;
    const { data, size } = bitmap(token);
    expect(decodeQr(data, size, size)).toBe(token);
  });
  it('returns null for an image with no QR code', () => {
    expect(decodeQr(new Uint8ClampedArray(200 * 200 * 4).fill(255), 200, 200)).toBeNull();
  });
  it('still decodes at a small module size (low-resolution camera)', () => {
    const { data, size } = bitmap('KIU1.short.token', 3);
    expect(decodeQr(data, size, size)).toBe('KIU1.short.token');
  });
});
