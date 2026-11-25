import { Button, Banner } from '@kiu/ui';
import { Camera, CameraOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeQr } from '../lib/qr-decode';

type CamState = 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'error';

/**
 * Camera QR scanner. Uses the native BarcodeDetector where available, otherwise jsQR on canvas frames.
 * States are explicit (permission requested / denied / unsupported) and a manual paste field is always offered.
 * Decoded values are debounced here; the parent additionally de-duplicates identical tokens.
 */
export function Scanner({ onToken, paused }: { onToken: (token: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const last = useRef({ at: 0, text: '' });
  const [state, setState] = useState<CamState>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [manual, setManual] = useState('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setState('idle');
  }, []);

  const start = useCallback(async (id?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) { setState('unsupported'); return; }
    setState('requesting');
    try {
      stream.current?.getTracks().forEach((t) => t.stop());
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
      setState('active');
    } catch (e) {
      const name = (e as DOMException).name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'error');
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (state !== 'active') return;
    const detector = 'BarcodeDetector' in window ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null;
    let busy = false;
    let lastFrame = 0;
    const tick = async (now: number) => {
      raf.current = requestAnimationFrame(tick);
      if (busy || pausedRef.current || now - lastFrame < 120) return; // ~8 fps is plenty and saves battery
      lastFrame = now;
      const v = video.current, c = canvas.current;
      if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
      busy = true;
      try {
        let text: string | null = null;
        if (detector) {
          const found = await detector.detect(v);
          text = found[0]?.rawValue ?? null;
        } else {
          c.width = v.videoWidth; c.height = v.videoHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          text = decodeQr(img.data, img.width, img.height);
        }
        if (text && !(text === last.current.text && Date.now() - last.current.at < 3000)) {
          last.current = { at: Date.now(), text };
          onToken(text);
        }
      } catch { /* a bad frame is not an error */ } finally { busy = false; }
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [state, onToken]);

  return (
    <div className="kiu-stack">
      <div style={{ position: 'relative', border: 'var(--border)', borderRadius: 16, overflow: 'hidden', background: '#111', aspectRatio: '4 / 3', maxHeight: '52vh', width: '100%' }}>
        <video ref={video} muted playsInline aria-label="Camera preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: state === 'active' ? 'block' : 'none' }} />
        <canvas ref={canvas} hidden />
        {state === 'active' && <div aria-hidden style={{ position: 'absolute', inset: '18%', border: '4px solid var(--yellow)', borderRadius: 18, boxShadow: '0 0 0 9999px rgba(0,0,0,.35)' }} />}
        {state !== 'active' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', padding: 16, textAlign: 'center' }}>
            <div>{state === 'denied' || state === 'unsupported' || state === 'error' ? <CameraOff size={40} /> : <Camera size={40} />}<p>{
              state === 'requesting' ? 'Waiting for camera permission…'
              : state === 'denied' ? 'Camera access was blocked. Allow it in the browser settings, or paste the code below.'
              : state === 'unsupported' ? 'No usable camera on this device. Paste the code below.'
              : state === 'error' ? 'The camera could not be started. Try again or paste the code.'
              : 'Camera is off'}</p></div>
          </div>
        )}
      </div>

      <div className="kiu-row">
        {state === 'active'
          ? <Button variant="secondary" onClick={stop}>Stop camera</Button>
          : <Button onClick={() => void start(deviceId || undefined)} data-testid="start-camera">Start camera</Button>}
        {devices.length > 1 && (
          <select className="kiu-input" style={{ width: 'auto' }} aria-label="Camera" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); void start(e.target.value); }}>
            <option value="">Default (rear)</option>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
          </select>
        )}
      </div>
      {state === 'denied' && <Banner tone="warn">Camera permission denied. The reader still works with the code box below.</Banner>}

      <form className="kiu-field" onSubmit={(e) => { e.preventDefault(); const t = manual.trim(); if (t) { onToken(t); setManual(''); } }}>
        <label htmlFor="manual-code">Or enter the code shown under the student's QR</label>
        <div className="kiu-row" style={{ flexWrap: 'nowrap' }}>
          <input id="manual-code" data-testid="manual-code" className="kiu-input mono" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="KIU1.…" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <Button type="submit" data-testid="manual-verify">Verify</Button>
        </div>
      </form>
    </div>
  );
}
