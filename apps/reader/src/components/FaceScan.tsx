import { Banner, Button, FaceCapture, Field, type FaceCaptureHandle, type FaceState } from '@kiu/ui';
import { useEffect, useRef, useState } from 'react';

export interface FaceOutcome { decision: 'GRANT' | 'DENY'; message: string; ms: number }
interface Props {
  /** Resolves with the server's decision, or rejects with a readable Error (e.g. offline). */
  onVerify: (regNo: string, frames: number[][]) => Promise<FaceOutcome>;
}

/** 1:1 face verification at the reader: claim a registration number, look at the camera, get an instant answer. */
export function FaceScan({ onVerify }: Props) {
  const cam = useRef<FaceCaptureHandle>(null);
  const [regNo, setRegNo] = useState('');
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<FaceState>('idle');
  const [caption, setCaption] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const reset = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(reset.current), []);

  const run = async () => {
    const id = regNo.trim();
    if (!id || busy || !ready) return;
    window.clearTimeout(reset.current);
    setBusy(true); setState('checking'); setCaption(undefined);
    const t0 = performance.now();
    try {
      const frames = await cam.current?.capture();
      if (!frames) throw new Error('The camera is not ready yet.');
      const r = await onVerify(id, frames);
      setState(r.decision === 'GRANT' ? 'ok' : 'fail');
      setCaption(`${r.message} · ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      setState('fail'); setCaption((e as Error).message);
    } finally {
      setBusy(false);
      reset.current = window.setTimeout(() => { setState('idle'); setCaption(undefined); }, 4000);
    }
  };

  return (
    <div className="kiu-stack" data-testid="face-scan">
      <Banner tone="info">Prototype. Face verification sends only a tiny numeric summary of five video frames, never a photo. Students with an exemption, and anyone whose face check fails, use the card or QR code.</Banner>
      <FaceCapture ref={cam} state={state} caption={caption} prototypeLabel="PROTOTYPE" onReady={setReady} />
      <form className="kiu-row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <div style={{ flex: '1 1 160px' }}><Field id="face-reg" label="Registration number" value={regNo} onChange={(e) => setRegNo(e.target.value)} autoComplete="off" placeholder="2026-BCS-0001" /></div>
        <Button type="submit" disabled={busy || !ready || !regNo.trim()} data-testid="face-verify">{busy ? 'Checking…' : 'Verify face'}</Button>
      </form>
    </div>
  );
}
