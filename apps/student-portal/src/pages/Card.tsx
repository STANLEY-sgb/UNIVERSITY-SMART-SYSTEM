import { Banner, Button, Card, CountdownRing, EmptyState, Field, StatusChip } from '@kiu/ui';
import { Copy, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { IdbKeyStorage, QR_TTL_SECONDS, activationProof, generateDeviceKey, nextQr, type DeviceKey } from '../lib/wallet';

const storage = new IdbKeyStorage();

interface MyCard { current: { id: string; cardNumber: string; status: string; expiresAt: string; activationExpiresAt: string | null } | null }
interface Me { displayName: string; student: { regNo: string; fullName: string } | null }

export function CardPage({ me }: { me: Me }) {
  const [card, setCard] = useState<MyCard['current'] | undefined>(undefined);
  const [device, setDevice] = useState<DeviceKey | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setCard((await api<MyCard>('GET', '/me/card')).current);
      setDevice(await storage.load());
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (card === undefined || device === undefined) return <div className="kiu-stack"><div className="kiu-skel" style={{ height: 180 }} /><div className="kiu-skel" style={{ height: 240 }} /></div>;
  if (error) return <Banner tone="deny">{error}</Banner>;
  if (!card) return <EmptyState title="No card yet">Ask the card office to issue your KIU smart card. You will receive an activation code.</EmptyState>;
  if (card.status === 'PENDING') return <Activate card={card} onDone={reload} />;
  if (card.status === 'ACTIVE' && device && device.cardNumber === card.cardNumber) return <ActiveCard me={me} card={card} />;
  if (card.status === 'ACTIVE') {
    return (
      <Banner tone="warn">
        Your card <b className="mono">{card.cardNumber}</b> is active, but this device is not enrolled for it (it may be on another phone).
        Ask the card office for a new activation code to move it here. The old device will stop working.
        <div style={{ marginTop: 10 }}><ActivateInline cardNumber={card.cardNumber} onDone={reload} /></div>
      </Banner>
    );
  }
  return <Banner tone="deny">Your card is <b>{card.status}</b>. {card.status === 'LOST' ? 'It can never be reactivated. Ask the card office for a replacement.' : 'Contact the card office.'}</Banner>;
}

function ActivateInline({ cardNumber, onDone }: { cardNumber: string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const key = await generateDeviceKey(cardNumber); // private key never leaves this device
      await api('POST', '/me/card/activate', { code, devicePublicKeyHex: key.publicKeyHex, proofHex: await activationProof(key), deviceLabel: navigator.userAgent.slice(0, 60) });
      await storage.save(key);
      onDone();
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : 'Activation failed.'); } finally { setBusy(false); }
  };
  return (
    <form className="kiu-stack" onSubmit={submit}>
      <Field id="activation-code" label="Activation code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH-JKLM" autoComplete="off" error={err} />
      <Button type="submit" disabled={code.replace(/[^A-Z0-9]/g, '').length < 12 || busy} data-testid="activate">{busy ? 'Activating…' : 'Activate on this device'}</Button>
    </form>
  );
}

function Activate({ card, onDone }: { card: NonNullable<MyCard['current']>; onDone: () => void }) {
  return (
    <Card className="kiu-stack">
      <h2>Activate your card</h2>
      <p>Card <b className="mono">{card.cardNumber}</b> is ready. Enter the one-time code from the card office. This device will create its own secret key; it is never sent anywhere.</p>
      <ActivateInline cardNumber={card.cardNumber} onDone={onDone} />
      {card.activationExpiresAt && <p className="kiu-hint">Code expires {new Date(card.activationExpiresAt).toLocaleString()}.</p>}
    </Card>
  );
}

function ActiveCard({ me, card }: { me: Me; card: NonNullable<MyCard['current']> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [qr, setQr] = useState<{ token: string; exp: number } | null>(null);
  const [left, setLeft] = useState(QR_TTL_SECONDS);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mint = useCallback(async () => {
    try {
      const t = await nextQr(storage);
      if (!t) { setErr('This device is not enrolled for the card.'); return; }
      setQr({ token: t.token, exp: t.exp });
      setLeft(Math.max(0, t.exp - Math.floor(Date.now() / 1000)));
    } catch { setErr('Could not create a code on this device.'); }
  }, []);

  useEffect(() => { void mint(); }, [mint]);
  useEffect(() => {
    // A new code every 30 s; the displayed ring ticks every second and the old code is replaced before it expires.
    const id = window.setInterval(() => {
      if (!qr) return;
      const remaining = qr.exp - Math.floor(Date.now() / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 2) void mint();
    }, 1000);
    return () => clearInterval(id);
  }, [qr, mint]);
  // A code minted while the tab was hidden is stale; refresh as soon as the page is visible again.
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible') void mint(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [mint]);
  useEffect(() => {
    if (qr && canvas.current) void QRCode.toCanvas(canvas.current, qr.token, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#111111', light: '#ffffff' } });
  }, [qr]);

  const initials = (me.student?.fullName ?? me.displayName).split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <div className="kiu-grid cols-2">
      <div className="kiu-idcard" data-testid="idcard">
        <div className="kiu-row" style={{ justifyContent: 'space-between' }}>
          <b style={{ fontFamily: 'var(--font-head)', letterSpacing: '.06em' }}>KIU SMART CARD</b>
          <StatusChip tone="grant">Active</StatusChip>
        </div>
        <div className="kiu-row">
          <div className="avatar" aria-hidden>{initials}</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.2rem' }} data-testid="card-name">{me.student?.fullName ?? me.displayName}</div>
            <div className="mono">{me.student?.regNo}</div>
          </div>
        </div>
        <div className="kiu-row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" data-testid="card-number">{card.cardNumber}</span>
          <span>Valid to {new Date(card.expiresAt).toLocaleDateString()}</span>
        </div>
        <div className="kiu-row"><ShieldCheck size={16} aria-hidden /><span>Secure rotating credential</span></div>
        <p style={{ fontSize: '.8rem', margin: 0, color: '#F3DDFB' }}>Prototype card. Fictional data. Not an official KIU document.</p>
      </div>

      <Card className="kiu-stack" style={{ textAlign: 'center' }}>
        <h2>Show this at the reader</h2>
        {err && <Banner tone="deny">{err}</Banner>}
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <canvas ref={canvas} data-testid="qr-canvas" aria-label="Your rotating QR code" style={{ width: '100%', maxWidth: 280, height: 'auto', border: 'var(--border)', borderRadius: 12 }} />
        </div>
        <div className="kiu-row" style={{ justifyContent: 'center' }}>
          <CountdownRing seconds={left} total={QR_TTL_SECONDS} />
          <span className="muted">Refreshes automatically. A screenshot stops working in seconds.</span>
        </div>
        <Button variant="secondary" onClick={async () => { if (qr) { await navigator.clipboard?.writeText(qr.token).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1500); } }} data-testid="copy-code">
          <Copy size={16} aria-hidden /> {copied ? 'Copied' : 'Copy code'}
        </Button>
        <p className="kiu-hint" style={{ margin: 0 }}>Use this for readers without a camera.</p>
        <output hidden data-testid="qr-token">{qr?.token}</output>
      </Card>
    </div>
  );
}
