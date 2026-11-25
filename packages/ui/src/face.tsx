import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/** Edge length of the luminance thumbnail the prototype adapter expects (see apps/api biometrics/mock-adapter.ts). */
export const FACE_FRAME_SIDE = 24;
const FRAMES = 5;
const GAP_MS = 55;

export type FaceState = 'idle' | 'checking' | 'ok' | 'fail';
export interface FaceCaptureHandle { capture: () => Promise<number[][] | null> }
interface Props {
  state: FaceState;
  /** Short result line shown under the frame, e.g. "Granted · 312 ms". */
  caption?: string | undefined;
  /** Shown as a corner badge so nobody mistakes the prototype engine for validated biometrics. */
  prototypeLabel?: string | undefined;
  onReady?: ((ready: boolean) => void) | undefined;
  compact?: boolean | undefined;
}

/**
 * Live camera with a vector face guide and instant, animated feedback. Only 24x24 luminance thumbnails ever leave this
 * component (five of them, ~0.3 s apart in total); no photograph is stored or uploaded.
 */
export const FaceCapture = forwardRef<FaceCaptureHandle, Props>(function FaceCapture({ state, caption, prototypeLabel, onReady, compact }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [camera, setCamera] = useState<'starting' | 'live' | 'blocked' | 'unsupported'>('starting');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) { setCamera('unsupported'); onReady?.(false); return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 320 }, frameRate: { ideal: 30 } } })
      .then(async (s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setCamera('live'); onReady?.(true);
      })
      .catch(() => { if (!stopped) { setCamera('blocked'); onReady?.(false); } });
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grab = useCallback((): number[] | null => {
    const v = video.current;
    if (!v || v.videoWidth === 0) return null;
    const c = (canvas.current ??= document.createElement('canvas'));
    c.width = c.height = FACE_FRAME_SIDE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const side = Math.min(v.videoWidth, v.videoHeight);
    // Centre square crop: the guide oval sits in the middle of this square.
    ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, FACE_FRAME_SIDE, FACE_FRAME_SIDE);
    const d = ctx.getImageData(0, 0, FACE_FRAME_SIDE, FACE_FRAME_SIDE).data;
    const out = new Array<number>(FACE_FRAME_SIDE * FACE_FRAME_SIDE);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!);
    return out;
  }, []);

  useImperativeHandle(ref, () => ({
    capture: async () => {
      const frames: number[][] = [];
      for (let i = 0; i < FRAMES; i++) {
        const f = grab();
        if (!f) return null;
        frames.push(f);
        if (i < FRAMES - 1) await new Promise((r) => setTimeout(r, GAP_MS));
      }
      return frames;
    },
  }), [grab]);

  return (
    <figure className={`kiu-face ${compact ? 'compact' : ''}`} data-state={state} data-camera={camera} data-testid="face-capture" style={{ margin: 0 }}>
      <div className="kiu-face-stage">
        <video ref={video} className="kiu-face-video" muted playsInline aria-label="Camera preview"><track kind="captions" src="data:text/vtt;charset=utf-8,WEBVTT" srcLang="en" label="No audio" /></video>
        {camera !== 'live' && (
          <div className="kiu-face-placeholder" role="status">
            {camera === 'starting' ? 'Starting camera…' : camera === 'blocked' ? 'Camera access was blocked. Allow it in the browser, or use the card / QR code instead.' : 'This device has no camera support. Use the card / QR code instead.'}
          </div>
        )}
        <svg className="kiu-face-guide" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
          <defs>
            <mask id="kiu-face-hole"><rect width="200" height="200" fill="#fff" /><ellipse cx="100" cy="98" rx="58" ry="74" fill="#000" /></mask>
          </defs>
          <rect width="200" height="200" fill="currentColor" opacity=".42" mask="url(#kiu-face-hole)" className="kiu-face-shade" />
          <ellipse cx="100" cy="98" rx="58" ry="74" className="kiu-face-ring" fill="none" strokeWidth="3.5" />
          <ellipse cx="100" cy="98" rx="58" ry="74" className="kiu-face-sweep" fill="none" strokeWidth="3.5" pathLength={100} />
          {[[14, 14, 1, 1], [186, 14, -1, 1], [14, 186, 1, -1], [186, 186, -1, -1]].map(([x, y, sx, sy], i) => (
            <path key={i} className="kiu-face-corner" fill="none" strokeWidth="3" strokeLinecap="round" d={`M${x! + sx! * 22} ${y}H${x}V${y! + sy! * 22}`} />
          ))}
          <g className="kiu-face-mark kiu-face-ok"><circle cx="100" cy="98" r="30" /><path d="M85 99l11 11 21-23" /></g>
          <g className="kiu-face-mark kiu-face-bad"><circle cx="100" cy="98" r="30" /><path d="M88 86l24 24M112 86l-24 24" /></g>
        </svg>
        {prototypeLabel && <span className="kiu-face-badge">{prototypeLabel}</span>}
      </div>
      <figcaption className="kiu-face-caption" role="status" aria-live="polite" data-testid="face-caption">
        {caption ?? (state === 'checking' ? 'Checking…' : camera === 'live' ? 'Centre your face in the oval' : '')}
      </figcaption>
    </figure>
  );
});
