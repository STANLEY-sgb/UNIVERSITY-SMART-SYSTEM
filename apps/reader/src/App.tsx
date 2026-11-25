import { OfflineEngine, type SignedManifest } from '@kiu/offline-core';
import { Banner, Button, Card, EmptyState, ResultPanel, Segmented, StatusChip } from '@kiu/ui';
import { CloudOff, RefreshCw, Volume2, VolumeX, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaceScan, type FaceOutcome } from './components/FaceScan';
import { Scanner } from './components/Scanner';
import { Setup, type SetupValues } from './components/Setup';
import { NetworkError, ReaderApi } from './lib/api';
import { beep } from './lib/beep';
import { IdbStore, settings as settingsDb, type ReaderSettings } from './lib/idb';
import { importHmacKey } from './lib/signing';

type Mode = 'QR' | 'TAP' | 'FACE';
interface Shown { decision: 'GRANT' | 'DENY'; reason: string; message: string; name: string | null; sub: string | null; offline: boolean; at: number; ms: number }
interface LogLine { at: string; method: string; path: string; status: string; ms: number }

const store = new IdbStore();
const SYNC_EVERY_MS = 5 * 60_000;

export function App() {
  const [cfg, setCfg] = useState<ReaderSettings | null | undefined>(undefined); // undefined = loading, null = not configured
  const [setupError, setSetupError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('QR');
  const [direction, setDirection] = useState<'ENTRY' | 'EXIT'>('ENTRY');
  const [shown, setShown] = useState<Shown | null>(null);
  const [doorOpen, setDoorOpen] = useState(false);
  const [events, setEvents] = useState<Shown[]>([]);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [manifest, setManifest] = useState<SignedManifest | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const recent = useRef({ token: '', at: 0 });
  const doorTimer = useRef<number>(0);

  const api = useMemo(() => (cfg ? new ReaderApi(cfg) : null), [cfg]);
  const engine = useMemo(() => (cfg ? new OfflineEngine(store, { readerCode: cfg.readerCode, serviceCode: cfg.serviceCode }) : null), [cfg]);

  const note = useCallback((method: string, path: string, status: string, ms: number) => {
    setLog((l) => [{ at: new Date().toLocaleTimeString(), method, path, status, ms }, ...l].slice(0, 12));
  }, []);

  useEffect(() => { void settingsDb.get().then((s) => setCfg(s ?? null)); }, []);
  useEffect(() => {
    if (!cfg) return;
    void store.queueSize().then(setQueued);
    void store.loadManifest().then(setManifest);
  }, [cfg]);

  /** Download a fresh signed allow-list, verify it, then flush queued offline decisions. */
  const sync = useCallback(async (quiet = false) => {
    if (!api || !engine) return;
    try {
      const res = await api.allowlist();
      note('GET', 'allowlist', String(res.status), res.ms);
      if (res.status !== 200) throw new Error(res.body?.message ?? `HTTP ${res.status}`);
      const verdict = await engine.acceptManifest(res.body as SignedManifest);
      if (!verdict.ok) throw new Error(`Allow-list rejected: ${verdict.error}`);
      setManifest(await store.loadManifest());
      const flushed = await engine.flush(async (batch) => {
        const up = await api.uploadLogs(batch);
        note('POST', 'logs', String(up.status), up.ms);
        return { ok: up.status === 200 };
      });
      setQueued(await store.queueSize());
      setOnline(true);
      setLastSync(new Date().toLocaleTimeString());
      if (!quiet || flushed.sent) setSyncMsg(flushed.sent ? `Synced. ${flushed.sent} offline record(s) uploaded.` : 'Synced.');
      if (flushed.failed) setSyncMsg('Some offline records could not be uploaded yet; they stay queued.');
    } catch (e) {
      if (e instanceof NetworkError) { setOnline(false); setSyncMsg('Offline: using the last signed list.'); }
      else setSyncMsg((e as Error).message);
    }
  }, [api, engine, note]);

  // Periodic sync, and immediately when the browser reports the network is back.
  useEffect(() => {
    if (!cfg) return;
    void sync(true);
    const id = window.setInterval(() => void sync(true), SYNC_EVERY_MS);
    const back = () => void sync();
    const lost = () => setOnline(false);
    window.addEventListener('online', back);
    window.addEventListener('offline', lost);
    return () => { clearInterval(id); window.removeEventListener('online', back); window.removeEventListener('offline', lost); };
  }, [cfg, sync]);

  const present = useCallback((s: Shown) => {
    setShown(s);
    setEvents((e) => [s, ...e].slice(0, 25));
    beep(s.decision === 'GRANT' ? 'grant' : 'deny', muted);
    window.clearTimeout(doorTimer.current);
    setDoorOpen(s.decision === 'GRANT');
    if (s.decision === 'GRANT') doorTimer.current = window.setTimeout(() => setDoorOpen(false), 3000); // 3-second door animation
  }, [muted]);

  const onToken = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (!api || !engine || !cfg || !token) return;
    // Duplicate-scan prevention: the camera sees the same code many times.
    if (token === recent.current.token && Date.now() - recent.current.at < 5000) return;
    recent.current = { token, at: Date.now() };
    setBusy(true);
    const dir = cfg.serviceCode === 'GATE' ? direction : undefined;
    try {
      // Online-first: the server decides within ~800 ms or the offline policy applies.
      const res = await api.verifyQr(token, dir);
      note('POST', 'access/verify', String(res.status), res.ms);
      setOnline(true);
      if (res.status === 200) {
        const b = res.body;
        present({
          decision: b.decision, reason: b.reason_code, message: b.message, name: b.student?.full_name ?? null,
          sub: b.student ? `${b.student.reg_no} · ${b.student.programme}` : null, offline: false, at: Date.now(), ms: res.ms,
        });
      } else {
        // The server answered but refused this READER (revoked, bad clock, throttled...): never fall back to offline for that.
        present({ decision: 'DENY', reason: res.body?.code ?? `HTTP_${res.status}`, message: res.body?.message ?? 'This reader is not authorised.', name: null, sub: null, offline: false, at: Date.now(), ms: res.ms });
      }
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setOnline(false);
      const t0 = performance.now();
      const d = await engine.decide(token, dir);
      note('LOCAL', 'offline-decision', d.decision, Math.round(performance.now() - t0));
      setQueued(await store.queueSize());
      present({ decision: d.decision, reason: d.reason, message: d.message, name: d.name, sub: null, offline: true, at: Date.now(), ms: Math.round(performance.now() - t0) });
    } finally {
      setBusy(false);
    }
  }, [api, engine, cfg, direction, note, present]);

  const onFace = useCallback(async (regNo: string, frames: number[][]): Promise<FaceOutcome> => {
    if (!api || !cfg) throw new Error('Reader is not connected.');
    const dir = cfg.serviceCode === 'GATE' ? direction : undefined;
    let res;
    try { res = await api.verifyFace(regNo, frames, dir); } catch (e) {
      if (e instanceof NetworkError) { setOnline(false); throw new Error('Face verification needs a connection. Use the card or QR code.'); }
      throw e;
    }
    note('POST', 'access/verify (face)', String(res.status), res.ms);
    setOnline(true);
    const b = res.body;
    const s: Shown = res.status === 200
      ? { decision: b.decision, reason: b.reason_code, message: b.message, name: b.student?.full_name ?? null, sub: b.student ? `${b.student.reg_no} · ${b.student.programme}` : null, offline: false, at: Date.now(), ms: res.ms }
      : { decision: 'DENY', reason: b?.code ?? `HTTP_${res.status}`, message: b?.message ?? 'This reader is not authorised.', name: null, sub: null, offline: false, at: Date.now(), ms: res.ms };
    present(s);
    return { decision: s.decision, message: s.decision === 'GRANT' ? 'Granted' : s.message, ms: s.ms };
  }, [api, cfg, direction, note, present]);

  const connect = async (v: SetupValues) => {
    setSetupError(null);
    try {
      const baseUrl = v.baseUrl.replace(/\/+$/, '');
      const hmacKey = await importHmacKey(v.secret);
      const probe = new ReaderApi({ baseUrl, keyId: v.keyId, hmacKey, readerId: v.readerId });
      const res = await probe.allowlist();
      if (res.status !== 200) throw new Error(res.body?.message ?? `The server refused these credentials (HTTP ${res.status}).`);
      const m = (res.body as SignedManifest).manifest;
      const next: ReaderSettings = { baseUrl, readerId: v.readerId, readerCode: m.reader, serviceCode: m.service, keyId: v.keyId, hmacKey };
      await settingsDb.clear();
      await settingsDb.set(next);
      const e = new OfflineEngine(store, { readerCode: m.reader, serviceCode: m.service });
      const verdict = await e.acceptManifest(res.body as SignedManifest);
      if (!verdict.ok) throw new Error(`Allow-list rejected: ${verdict.error}`);
      setCfg(next);
    } catch (e) {
      setSetupError(e instanceof NetworkError ? 'Could not reach the server. Check the address and that CORS allows this origin.' : (e as Error).message);
    }
  };

  const disconnect = async () => { await settingsDb.clear(); setCfg(null); setManifest(null); setShown(null); setEvents([]); setQueued(0); };

  if (cfg === undefined) return <main className="kiu-page"><p>Loading…</p></main>;
  if (cfg === null) return <Setup onConnect={connect} error={setupError} />;

  const m = manifest?.manifest;
  const stale = m ? Date.parse(m.validUntil) < Date.now() : true;

  return (
    <main className="kiu-page">
      <header className="kiu-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>KIU Reader</h1>
          <span className="muted mono" data-testid="reader-id">{cfg.readerCode} · {cfg.serviceCode}</span>
        </div>
        <div className="kiu-row">
          <span data-testid="conn" data-online={online}><StatusChip tone={online ? 'grant' : 'warn'}>{online ? <><Wifi size={14} aria-hidden /> Online</> : <><CloudOff size={14} aria-hidden /> Offline</>}</StatusChip></span>
          <span data-testid="queue" data-count={queued}><StatusChip tone={queued ? 'warn' : 'info'}>{queued} queued</StatusChip></span>
        </div>
      </header>

      <div className="kiu-stack">
        <Segmented<Mode> label="Credential type" value={mode} onChange={setMode} options={[
          { value: 'QR', label: 'SCAN QR' },
          { value: 'TAP', label: 'VIRTUAL TAP', disabled: true, title: 'Virtual tap runs in the simulator; the browser reader cannot do AES-CMAC yet' },
          { value: 'FACE', label: 'SCAN FACE', title: 'Optional 1:1 face verification (prototype adapter, online only)' },
        ]} />
        <p className="kiu-hint" style={{ margin: 0 }}>Virtual tap is available in the simulator CLI. Face verification is a labelled prototype and is online-only.</p>

        {cfg.serviceCode === 'GATE' && (
          <Segmented<'ENTRY' | 'EXIT'> label="Gate direction" value={direction} onChange={setDirection} options={[{ value: 'ENTRY', label: 'ENTRY' }, { value: 'EXIT', label: 'EXIT' }]} />
        )}

        {!online && (
          <Banner tone="warn">
            Offline. {m?.policy === 'CACHED_ALLOW' && !stale ? 'Decisions use the signed offline list and are queued for upload.' : 'This service cannot be verified offline, so every scan is refused.'}
          </Banner>
        )}

        <div className="kiu-grid cols-2">
          {/* verdict first: on a phone the operator must see GRANT/DENY without scrolling past the camera */}
          <div className="kiu-stack">
            {shown
              ? <ResultPanel decision={shown.decision} reason={shown.reason} message={shown.message} name={shown.name} sub={shown.sub} doorOpen={doorOpen} offline={shown.offline} />
              : <EmptyState title="Ready to scan">{mode === 'FACE' ? 'Enter the registration number, then look at the camera.' : "Hold the student's QR code in front of the camera."}</EmptyState>}
            <p className="muted" aria-live="polite" data-testid="latency">{shown ? `Decision in ${shown.ms} ms${shown.offline ? ' (local)' : ''}` : ''}</p>
          </div>
          <Card className="kiu-stack">
            <h2>{mode === 'FACE' ? 'Scan face' : 'Scan'}</h2>
            {mode === 'FACE' ? <FaceScan onVerify={onFace} /> : <Scanner onToken={(t) => void onToken(t)} paused={busy} />}
          </Card>
        </div>

        <Card>
          <h2>Recent events</h2>
          {events.length === 0 ? <p className="muted">Nothing scanned yet.</p> : (
            <table className="kiu-table" data-testid="events">
              <thead><tr><th>Time</th><th>Result</th><th>Student</th><th>Reason</th><th>Mode</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.at}>
                    <td data-label="Time">{new Date(e.at).toLocaleTimeString()}</td>
                    <td data-label="Result"><StatusChip tone={e.decision === 'GRANT' ? 'grant' : 'deny'}>{e.decision}</StatusChip></td>
                    <td data-label="Student">{e.name ?? '—'}</td>
                    <td data-label="Reason" className="mono">{e.reason}</td>
                    <td data-label="Mode">{e.offline ? 'Offline' : 'Online'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <details className="kiu-card" open={false}>
          <summary style={{ cursor: 'pointer', fontWeight: 800 }}>Diagnostics</summary>
          <div className="kiu-stack" style={{ marginTop: 12 }}>
            <div className="kiu-row">
              <Button variant="secondary" onClick={() => void sync()} data-testid="sync"><RefreshCw size={16} aria-hidden /> Sync now</Button>
              <Button variant="secondary" onClick={() => setMuted(!muted)} aria-pressed={muted}>{muted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />} {muted ? 'Unmute' : 'Mute'}</Button>
              <Button variant="danger" onClick={() => void disconnect()}>Disconnect reader</Button>
            </div>
            {syncMsg && <Banner tone="info">{syncMsg}</Banner>}
            <dl className="kiu-grid cols-2" style={{ margin: 0 }} data-testid="diagnostics">
              <div><dt className="muted">Offline policy</dt><dd>{m?.policy ?? '—'}</dd></div>
              <div><dt className="muted">List version</dt><dd data-testid="list-version">{m?.version ?? '—'}</dd></div>
              <div><dt className="muted">Cards in offline list</dt><dd data-testid="list-cards">{m?.cards.length ?? '—'}</dd></div>
              <div><dt className="muted">Revocation version</dt><dd>{m?.revocationVersion ?? '—'}</dd></div>
              <div><dt className="muted">List valid until</dt><dd>{m ? new Date(m.validUntil).toLocaleTimeString() : '—'} {m && stale && <StatusChip tone="warn">expired</StatusChip>}</dd></div>
              <div><dt className="muted">Last sync</dt><dd>{lastSync ?? '—'}</dd></div>
            </dl>
            <p className="kiu-hint">An isolated reader cannot learn of revocations issued after its last sync; the list expires quickly to bound that risk.</p>
            <table className="kiu-table">
              <thead><tr><th>Time</th><th>Call</th><th>Status</th><th>ms</th></tr></thead>
              <tbody>{log.map((l, i) => <tr key={i}><td data-label="Time">{l.at}</td><td data-label="Call">{l.method} {l.path}</td><td data-label="Status">{l.status}</td><td data-label="ms">{l.ms}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      </div>
    </main>
  );
}
