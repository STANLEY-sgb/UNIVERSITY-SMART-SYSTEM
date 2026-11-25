import jsQR from 'jsqr';

/** Decodes a QR code from RGBA pixels (camera frame or test bitmap). Returns the text or null. */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
}
