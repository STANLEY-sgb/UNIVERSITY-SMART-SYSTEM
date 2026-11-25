/**
 * PROTOTYPE-ONLY face adapter. It is NOT a face-recognition model and has no accuracy, anti-spoofing or demographic
 * evidence. It compares tiny 24x24 luminance thumbnails by cosine similarity, which is enough to demonstrate the whole
 * pipeline (consent, enrolment, 1:1 verification, audit, revocation) end to end, and nothing more.
 * A production adapter must implement `FaceAdapter` over an independently evaluated SDK before any real use
 * (docs/BIOMETRIC_PRIVACY.md). Every surface that touches this adapter shows `isMock`.
 */
export const FRAME_SIDE = 24;
export const FRAME_LEN = FRAME_SIDE * FRAME_SIDE;
export const MIN_FRAMES = 3;
export const MAX_FRAMES = 8;

export type ExtractFailure = 'BAD_INPUT' | 'QUALITY_FAILED' | 'LIVENESS_FAILED';
export type Extracted = { ok: true; template: number[]; quality: number } | { ok: false; failure: ExtractFailure; detail: string };

export interface FaceAdapter {
  readonly name: string;
  readonly version: string;
  readonly isMock: boolean;
  extract(frames: unknown): Extracted;
  compare(a: number[], b: number[]): number;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const std = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };

/** Mean absolute pixel change between two frames: sensor noise is ~1; a live, slightly moving head is larger. */
const motion = (a: number[], b: number[]) => mean(a.map((x, i) => Math.abs(x - b[i]!)));

export const MIN_MOTION = 0.6;
export const MAX_MOTION = 40;

export class MockFaceAdapter implements FaceAdapter {
  readonly name = 'prototype-luminance-mock';
  readonly version = '0.1';
  readonly isMock = true;

  extract(frames: unknown): Extracted {
    if (!Array.isArray(frames) || frames.length < MIN_FRAMES || frames.length > MAX_FRAMES) return { ok: false, failure: 'BAD_INPUT', detail: `send ${MIN_FRAMES}-${MAX_FRAMES} frames` };
    const fs: number[][] = [];
    for (const f of frames) {
      if (!Array.isArray(f) || f.length !== FRAME_LEN || !f.every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return { ok: false, failure: 'BAD_INPUT', detail: `each frame must be ${FRAME_LEN} values 0-255` };
      fs.push(f as number[]);
    }
    // Quality: exposure in range and enough contrast to carry any structure.
    const all = fs.flat();
    const brightness = mean(all), contrast = std(fs[Math.floor(fs.length / 2)]!);
    if (brightness < 45 || brightness > 215) return { ok: false, failure: 'QUALITY_FAILED', detail: brightness < 45 ? 'too dark' : 'too bright' };
    if (contrast < 12) return { ok: false, failure: 'QUALITY_FAILED', detail: 'not enough detail' };
    // Liveness (mock): a perfectly still sequence (photo on a screen, frozen stream) or chaos (different scenes) fails.
    let peak = 0;
    for (let i = 1; i < fs.length; i++) peak = Math.max(peak, motion(fs[i - 1]!, fs[i]!));
    if (peak < MIN_MOTION) return { ok: false, failure: 'LIVENESS_FAILED', detail: 'no natural movement' };
    if (peak > MAX_MOTION) return { ok: false, failure: 'LIVENESS_FAILED', detail: 'scene changed during capture' };

    const avg = new Array<number>(FRAME_LEN).fill(0);
    for (const f of fs) for (let i = 0; i < FRAME_LEN; i++) avg[i]! += f[i]! / fs.length;
    const m = mean(avg);
    const centred = avg.map((x) => x - m);
    const norm = Math.sqrt(centred.reduce((s, x) => s + x * x, 0)) || 1;
    return { ok: true, template: centred.map((x) => Math.round((x / norm) * 1e5) / 1e5), quality: Math.min(1, contrast / 60) };
  }

  compare(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    return Math.max(-1, Math.min(1, dot));
  }
}
