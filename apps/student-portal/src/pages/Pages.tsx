import { Banner, Button, Card, EmptyState, Field, PasswordField, Skeleton, StatusChip, TextArea, type Tone } from '@kiu/ui';
import { Building2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { IdbKeyStorage } from '../lib/wallet';

function useLoad<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    api<T>('GET', path).then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  return { data, error };
}

const TONE: Record<string, Tone> = { ELIGIBLE: 'grant', NOT_ELIGIBLE: 'deny', UNKNOWN: 'warn', NOT_APPLICABLE: 'info', UNAVAILABLE: 'info' };
const LABEL: Record<string, string> = { ELIGIBLE: 'Available', NOT_ELIGIBLE: 'Not available', UNKNOWN: 'Unconfirmed', NOT_APPLICABLE: 'Not applicable', UNAVAILABLE: 'Unavailable' };

interface Eligibility {
  student: { reg_no: string; full_name: string; programme: string; year_of_study: number };
  card: { status: string } | null;
  services: { service: string; name: string; status: string; reason_code: string | null; message: string; office: string | null; detail?: Record<string, string> }[];
}

export function AccessPage({ summary = false }: { summary?: boolean }) {
  const { data, error } = useLoad<Eligibility>('/me/eligibility');
  if (error) return <Banner tone="deny">{error}</Banner>;
  if (!data) return <div className="kiu-grid cols-2">{[0, 1, 2, 3].map((i) => <Card key={i}><Skeleton h={22} w="60%" /><div style={{ height: 8 }} /><Skeleton /></Card>)}</div>;
  const ok = data.services.filter((s) => s.status === 'ELIGIBLE').length;
  const shown = summary ? data.services.filter((s) => s.status !== 'UNAVAILABLE').slice(0, 4) : data.services;
  return (
    <div className="kiu-stack">
      <p className="muted" data-testid="eligibility-summary">{ok} of {data.services.length} services are available to you right now.</p>
      <div className="kiu-grid cols-2" data-testid="eligibility">
        {shown.map((s) => (
          <Card key={s.service} data-testid={`svc-${s.service}`} data-status={s.status}>
            <div className="kiu-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{s.name}</h3>
              <StatusChip tone={TONE[s.status] ?? 'info'}>{LABEL[s.status] ?? s.status}</StatusChip>
            </div>
            <p style={{ margin: '10px 0 0' }}>{s.message}</p>
            {s.detail?.title && <p className="muted" style={{ margin: '6px 0 0' }}>{s.detail.title} · {s.detail.venue} · {s.detail.starts_at ? new Date(s.detail.starts_at).toLocaleString() : ''}</p>}
            {s.status !== 'ELIGIBLE' && s.office && <p className="kiu-row" style={{ margin: '10px 0 0', fontWeight: 700 }}><Building2 size={16} aria-hidden /> See: {s.office}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}

interface Paged<T> { data: T[]; meta: { total: number; page: number; totalPages: number } }

export function HistoryPage() {
  const [page, setPage] = useState(1);
  const { data, error } = useLoad<Paged<{ id: string; occurredAt: string; decision: 'GRANT' | 'DENY'; reasonCode: string; message: string; offline: boolean; service: { name: string } | null; venue: { name: string } | null }>>(`/me/access-history?page=${page}&pageSize=15`, [page]);
  if (error) return <Banner tone="deny">{error}</Banner>;
  if (!data) return <Skeleton h={120} />;
  if (data.data.length === 0) return <EmptyState title="No access yet">Your gate, library, exam and meal scans will appear here.</EmptyState>;
  return (
    <Card>
      <table className="kiu-table" data-testid="history">
        <thead><tr><th>When</th><th>Service</th><th>Where</th><th>Result</th><th>Why</th></tr></thead>
        <tbody>
          {data.data.map((r) => (
            <tr key={r.id}>
              <td data-label="When">{new Date(r.occurredAt).toLocaleString()}</td>
              <td data-label="Service">{r.service?.name ?? '—'}</td>
              <td data-label="Where">{r.venue?.name ?? '—'}{r.offline ? ' (offline)' : ''}</td>
              <td data-label="Result"><StatusChip tone={r.decision === 'GRANT' ? 'grant' : 'deny'}>{r.decision}</StatusChip></td>
              <td data-label="Why">{r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="kiu-row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <span className="muted">Page {data.meta.page} of {data.meta.totalPages}</span>
        <Button variant="secondary" disabled={page >= data.meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
      </div>
    </Card>
  );
}

export function NotificationsPage({ onRead }: { onRead: () => void }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useLoad<Paged<{ id: string; title: string; body: string; readAt: string | null; createdAt: string }> & { unread: number }>('/me/notifications?pageSize=30', [tick]);
  if (error) return <Banner tone="deny">{error}</Banner>;
  if (!data) return <Skeleton h={100} />;
  return (
    <div className="kiu-stack">
      {data.unread > 0 && <Button variant="secondary" onClick={async () => { await api('POST', '/me/notifications/read-all', {}); setTick(tick + 1); onRead(); }}>Mark all as read</Button>}
      {data.data.length === 0 && <EmptyState title="No notifications" />}
      {data.data.map((n) => (
        <Card key={n.id} flat style={{ borderLeft: n.readAt ? undefined : '8px solid var(--pink)' }}>
          <div className="kiu-row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>{n.title}</h3><span className="muted">{new Date(n.createdAt).toLocaleString()}</span></div>
          <p style={{ margin: '6px 0 0' }}>{n.body}</p>
        </Card>
      ))}
    </div>
  );
}

export interface FaceMine { enrolled: boolean; enrollment: { status: string; enrolledAt: string | null; lastVerifiedAt: string | null } | null; prototypeOnly: boolean; alternative: string; required: boolean; enforceFrom: string | null; exempt: boolean; exemptReason: string | null }

/** What a student must do about compulsory face enrolment, in plain words. */
export function faceNeed(f: FaceMine | null): { tone: 'warn' | 'deny'; text: string } | null {
  if (!f || !f.required || f.enrolled || f.exempt) return null;
  const due = f.enforceFrom ? new Date(`${f.enforceFrom}T00:00:00`) : null;
  if (due && due.getTime() <= Date.now()) return { tone: 'deny', text: 'Face enrolment is required and the deadline has passed. Your card is refused at readers until you enrol. Visit the enrolment desk, or ask for an exemption.' };
  return { tone: 'warn', text: `Face enrolment is compulsory. Visit the enrolment desk${due ? ` before ${due.toLocaleDateString()}` : ' (the university will announce the deadline)'}, or ask there for an exemption.` };
}

/** Shown on Home while face enrolment is compulsory and this student has not yet enrolled or been exempted. */
export function FaceNeedBanner() {
  const { data } = useLoad<FaceMine>('/me/biometrics');
  const need = faceNeed(data);
  return need ? <div data-testid="face-need-home"><Banner tone={need.tone}>{need.text} <a href="#/account">My face</a></Banner></div> : null;
}

/** "My face": see whether a face template exists and delete it at any time. Enrolment itself happens in person. */
function FaceSettings() {
  const [tick, setTick] = useState(0);
  const { data, error } = useLoad<FaceMine>('/me/biometrics', [tick]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const withdraw = async () => {
    setBusy(true);
    try { await api('POST', '/me/biometrics/withdraw', {}); setMsg('Your face data was deleted. Your card and QR code are unaffected.'); setTick((t) => t + 1); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Could not remove your face data.'); } finally { setBusy(false); }
  };
  return (
    <Card className="kiu-stack" data-testid="face-settings">
      <h2>My face</h2>
      {error && <Banner tone="deny">{error}</Banner>}
      {data && (
        <>
          <p style={{ margin: 0 }}>
            <StatusChip tone={data.enrolled ? 'grant' : 'info'}>{data.enrolled ? 'Face verification on' : 'Not enrolled'}</StatusChip>{' '}
            {data.enrollment?.lastVerifiedAt && <span className="muted">Last used {new Date(data.enrollment.lastVerifiedAt).toLocaleString()}</span>}
          </p>
          {(() => { const need = faceNeed(data); return need ? <Banner tone={need.tone} data-testid="face-need">{need.text}</Banner> : null; })()}
          {data.exempt && <p style={{ margin: 0 }} data-testid="face-exempt"><StatusChip tone="info">Exempt</StatusChip> You are excused from face enrolment{data.exemptReason ? ` (${data.exemptReason})` : ''}. {data.alternative}</p>}
          <p style={{ margin: 0 }}>{data.enrolled ? (data.required ? 'You can delete your face data at any time, but you will then need to enrol again unless you have an exemption.' : 'You can delete your face data at any time.') : data.required ? 'Enrolment is done in person at the enrolment desk.' : 'Face verification is optional and is set up in person at the enrolment desk.'} {data.alternative}</p>
          {data.prototypeOnly && <p className="muted" style={{ margin: 0 }}>Prototype system: not a validated biometric product.</p>}
          {data.enrolled && <Button variant="danger" onClick={() => void withdraw()} disabled={busy} data-testid="face-withdraw">Delete my face data</Button>}
        </>
      )}
      {msg && <Banner tone="info">{msg}</Banner>}
    </Card>
  );
}

export function AccountPage({ me, onLogout }: { me: { email: string; displayName: string; student: { regNo: string } | null }; onLogout: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reportLost = async () => {
    setBusy(true);
    try {
      await api('POST', '/me/card/report-lost', { reason });
      await new IdbKeyStorage().clear(); // the device key is useless now; drop it
      setMsg({ tone: 'info', text: 'Your card was disabled. Visit the card office for a replacement; your access rights stay with you.' });
      setConfirming(false);
    } catch (e) {
      setMsg({ tone: 'deny', text: e instanceof ApiError ? e.message : 'Could not report the card.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <Card className="kiu-stack">
        <h2>Account</h2>
        <p><b>{me.displayName}</b><br /><span className="muted">{me.email}{me.student ? ` · ${me.student.regNo}` : ''}</span></p>
        <Button variant="secondary" onClick={onLogout} data-testid="logout">Sign out</Button>
      </Card>
      <FaceSettings />
      <Card className="kiu-stack">
        <h2>Lost your phone or card?</h2>
        <p>Report it straight away. The card is disabled everywhere and can never be reactivated; the card office will issue a new one.</p>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        {!confirming
          ? <Button variant="danger" onClick={() => setConfirming(true)} data-testid="report-lost">Report my card lost</Button>
          : (
            <form className="kiu-stack" onSubmit={(e) => { e.preventDefault(); void reportLost(); }}>
              <TextArea id="lost-reason" label="What happened? (at least 5 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Banner tone="warn">This cannot be undone.</Banner>
              <div className="kiu-row">
                <Button type="submit" variant="danger" disabled={reason.trim().length < 5 || busy} data-testid="confirm-lost">Yes, disable my card</Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </form>
          )}
      </Card>
    </div>
  );
}

export function Login({ onLoggedIn, onCreateAccount }: { onLoggedIn: () => void; onCreateAccount: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api('POST', '/auth/login', { email, password });
      const me = await api<{ userType: string }>('GET', '/auth/me');
      if (me.userType !== 'STUDENT') { await api('POST', '/auth/logout', {}); throw new ApiError(403, 'NOT_STUDENT', 'This app is for students. Staff use the admin console.'); }
      onLoggedIn();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e2.message) : 'Could not reach the server.');
    } finally { setBusy(false); }
  };
  return (
    <main className="kiu-page" style={{ maxWidth: 480 }}>
      <h1>KIU Wallet</h1>
      <Card className="kiu-stack">
        <form className="kiu-stack" onSubmit={submit}>
          <Field id="email" label="University email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField id="password" label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <Banner tone="deny">{err}</Banner>}
          <Button type="submit" block disabled={!email || !password || busy} data-testid="login">{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <button type="button" className="kiu-btn secondary block" onClick={onCreateAccount} data-testid="go-register">New here? Create an account</button>
        <p className="kiu-hint">Prototype with fictional data. Not an official KIU service.</p>
      </Card>
    </main>
  );
}

export function Register({ onRegistered, onBack }: { onRegistered: () => void; onBack: () => void }) {
  const [regNo, setRegNo] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && password !== confirm;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api('POST', '/auth/register', { regNo, email, password });
      onRegistered();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e2.message) : 'Could not reach the server.');
    } finally { setBusy(false); }
  };
  return (
    <main className="kiu-page" style={{ maxWidth: 480 }}>
      <h1>Create your account</h1>
      <Card className="kiu-stack">
        <form className="kiu-stack" onSubmit={submit}>
          <Field id="reg-no" label="Registration number" hint="As issued by Registry, e.g. 2023-BCS-001" value={regNo} onChange={(e) => setRegNo(e.target.value)} autoComplete="off" />
          <Field id="reg-email" label="University email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField id="reg-password" label="Password" hint="At least 12 characters." autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordField id="reg-confirm" label="Confirm password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'Passwords do not match' : null} />
          {err && <Banner tone="deny">{err}</Banner>}
          <Button type="submit" block disabled={!regNo || !email || !password || !confirm || busy} data-testid="register-submit">{busy ? 'Creating account…' : 'Create account'}</Button>
        </form>
        <button type="button" className="kiu-btn secondary block" onClick={onBack} data-testid="go-login">Already have an account? Sign in</button>
        <p className="kiu-hint">Prototype with fictional data. Not an official KIU service. Your registration number must already be on file with Registry.</p>
      </Card>
    </main>
  );
}
