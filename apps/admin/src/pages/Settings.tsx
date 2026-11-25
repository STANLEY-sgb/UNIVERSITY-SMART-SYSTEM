import { Banner, Button, Card, DataTable, Field, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';

interface PolicyView { values: { fine_limit_ugx: number; exam_min_fees_percent: number; gate_direction_required: boolean }; defaults: Record<string, unknown> }
interface Venue { id: string; code: string; name: string; kind: string; capacity: number | null; opensAt: string | null; closesAt: string | null; readers: number }
interface Semester { id: string; number: number; startsOn: string; endsOn: string; isCurrent: boolean }
interface Session { id: string; code: string; startsOn: string; endsOn: string; isCurrent: boolean; semesters: Semester[] }

const KINDS = ['GATE', 'LIBRARY', 'EXAM_HALL', 'LECTURE_ROOM', 'HOSTEL', 'CAFETERIA', 'LAB', 'HEALTH', 'OTHER'];

export function Settings() {
  return (
    <div className="kiu-stack">
      <PageHeader title="Settings" />
      <PolicyCard />
      <VenuesCard />
      <CalendarCard />
    </div>
  );
}

function PolicyCard() {
  const p = useApi<PolicyView>('/settings/policy');
  const [draft, setDraft] = useState<{ fine: string; fees: string; dir: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const v = p.data?.values;
  const d = draft ?? (v ? { fine: String(v.fine_limit_ugx), fees: String(v.exam_min_fees_percent), dir: v.gate_direction_required } : null);
  const changed = !!v && !!d && (Number(d.fine) !== v.fine_limit_ugx || Number(d.fees) !== v.exam_min_fees_percent || d.dir !== v.gate_direction_required);
  const valid = !!d && Number.isInteger(Number(d.fine)) && Number(d.fine) >= 0 && Number(d.fees) >= 0 && Number(d.fees) <= 100 && d.fees.trim() !== '' && d.fine.trim() !== '';
  const save = async () => {
    setErr(null); setOk(false);
    try { await api('PATCH', '/settings/policy', { fine_limit_ugx: Number(d!.fine), exam_min_fees_percent: Number(d!.fees), gate_direction_required: d!.dir, reason }); setReason(''); setDraft(null); setOk(true); p.reload(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <Card className="kiu-stack">
      <h2>Access policy values</h2>
      <Banner tone="info">These are placeholders until the university confirms its real policy. Changes apply to the very next scan and are audited with your reason.</Banner>
      {!d ? <Skeleton h={100} /> : (
        <>
          <div className="kiu-grid cols-2">
            <Field id="pol-fine" label="Library fine limit for borrowing (UGX)" inputMode="numeric" value={d.fine} onChange={(e) => setDraft({ ...d, fine: e.target.value })} />
            <Field id="pol-fees" label="Minimum fees paid for exam clearance (%)" inputMode="decimal" value={d.fees} onChange={(e) => setDraft({ ...d, fees: e.target.value })} />
          </div>
          <label className="kiu-row" style={{ minHeight: 44 }}><input type="checkbox" checked={d.dir} onChange={(e) => setDraft({ ...d, dir: e.target.checked })} style={{ width: 24, height: 24 }} /> Gate readers must send ENTRY or EXIT (turns on anti-passback for every gate scan)</label>
          <Field id="pol-reason" label="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="kiu-row"><Button onClick={save} disabled={!changed || !valid || reason.trim().length < 5} data-testid="policy-save">Save policy</Button></div>
        </>
      )}
      {err && <Banner tone="deny">{err}</Banner>}
      {ok && <Banner tone="grant">Policy saved. It applies from the next scan.</Banner>}
    </Card>
  );
}

function VenuesCard() {
  const v = useApi<Venue[]>('/settings/venues');
  const [f, setF] = useState({ code: '', name: '', kind: 'LECTURE_ROOM', capacity: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', '/settings/venues', { code: f.code.trim().toUpperCase(), name: f.name.trim(), kind: f.kind, ...(f.capacity ? { capacity: Number(f.capacity) } : {}), reason: f.reason }); setF({ ...f, code: '', name: '', capacity: '', reason: '' }); v.reload(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <Card className="kiu-stack">
      <h2>Venues</h2>
      <form className="kiu-stack" onSubmit={add}>
        <div className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 110px' }}><Field id="v-code" label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="LH-2" /></div>
          <div style={{ flex: '2 1 160px' }}><Field id="v-name" label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="kiu-field" style={{ flex: '1 1 150px' }}><label htmlFor="v-kind">Kind</label><select id="v-kind" className="kiu-input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select></div>
          <div style={{ flex: '1 1 90px' }}><Field id="v-cap" label="Capacity" inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></div>
        </div>
        <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}><Field id="v-reason" label="Reason (audited)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
          <Button type="submit" disabled={busy || !f.code.trim() || f.name.trim().length < 2 || f.reason.trim().length < 5} data-testid="venue-add">{busy ? 'Saving…' : 'Add venue'}</Button>
        </div>
      </form>
      {err && <Banner tone="deny">{err}</Banner>}
      {v.error && <Banner tone="deny">{v.error}</Banner>}
      {v.loading && !v.data ? <Skeleton h={100} /> : (
        <DataTable testId="venues" rows={v.data ?? []} empty="No venues." columns={[
          { key: 'c', header: 'Code', render: (x) => <span className="mono">{x.code}</span> },
          { key: 'n', header: 'Name', render: (x) => x.name },
          { key: 'k', header: 'Kind', render: (x) => x.kind.replace('_', ' ') },
          { key: 'cap', header: 'Capacity', render: (x) => x.capacity ?? '—' },
          { key: 'r', header: 'Readers', render: (x) => x.readers },
        ]} />
      )}
    </Card>
  );
}

function CalendarCard() {
  const s = useApi<Session[]>('/settings/sessions');
  const [f, setF] = useState({ code: '', startsOn: '', endsOn: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ kind: 'current'; sem: Semester; session: string } | { kind: 'semester'; session: Session } | null>(null);
  const [sem, setSem] = useState({ number: '1', startsOn: '', endsOn: '' });
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', '/settings/sessions', f); setF({ code: '', startsOn: '', endsOn: '', reason: '' }); s.reload(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <Card className="kiu-stack">
      <h2>Academic calendar</h2>
      <p className="muted" style={{ margin: 0 }}>The <strong>current semester</strong> drives eligibility, registration and examination scheduling. Switching it affects every scan from that moment.</p>
      <form className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={add}>
        <div style={{ flex: '1 1 120px' }}><Field id="s-code" label="Session" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="2027/2028" /></div>
        <div className="kiu-field" style={{ flex: '1 1 150px' }}><label htmlFor="s-from">Starts</label><input id="s-from" className="kiu-input" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></div>
        <div className="kiu-field" style={{ flex: '1 1 150px' }}><label htmlFor="s-to">Ends</label><input id="s-to" className="kiu-input" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></div>
        <div style={{ flex: '2 1 200px' }}><Field id="s-reason" label="Reason (audited)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
        <Button type="submit" disabled={busy || !/^\d{4}\/\d{4}$/.test(f.code) || !f.startsOn || !f.endsOn || f.reason.trim().length < 5} data-testid="session-add">Add session</Button>
      </form>
      {err && <Banner tone="deny">{err}</Banner>}
      {s.loading && !s.data ? <Skeleton h={100} /> : (
        <div className="kiu-stack" data-testid="sessions">
          {(s.data ?? []).map((x) => (
            <div key={x.id} className="kiu-stack" style={{ borderTop: '2px solid var(--ink)', paddingTop: 10 }}>
              <div className="kiu-row" style={{ justifyContent: 'space-between' }}>
                <strong>{x.code} <span className="muted">{x.startsOn} → {x.endsOn}</span> {x.isCurrent && <StatusChip tone="grant">Current</StatusChip>}</strong>
                <Button variant="secondary" onClick={() => { setSem({ number: String(x.semesters.length + 1), startsOn: '', endsOn: '' }); setTarget({ kind: 'semester', session: x }); }}>Add semester</Button>
              </div>
              <DataTable rows={x.semesters} empty="No semesters yet." columns={[
                { key: 'n', header: 'Semester', render: (m) => m.number },
                { key: 'd', header: 'Dates', render: (m) => `${m.startsOn} → ${m.endsOn}` },
                { key: 'c', header: 'Status', render: (m) => m.isCurrent ? <StatusChip tone="grant">Current</StatusChip> : null },
                { key: 'a', header: 'Actions', render: (m) => m.isCurrent ? null : <Button variant="secondary" onClick={() => setTarget({ kind: 'current', sem: m, session: x.code })} data-testid={`make-current-${x.code}-${m.number}`}>Make current</Button> },
              ]} />
            </div>
          ))}
        </div>
      )}
      {target?.kind === 'current' && <ReasonModal title="Switch current semester" intro={`Make ${target.session} semester ${target.sem.number} the current semester? Eligibility and scheduling use it immediately.`} confirmLabel="Make current"
        onClose={() => setTarget(null)} onConfirm={async (reason) => { await api('POST', `/settings/semesters/${target.sem.id}/make-current`, { reason }); s.reload(); }} />}
      {target?.kind === 'semester' && (
        <ReasonModal title={`Add semester to ${target.session.code}`} confirmLabel="Add semester" onClose={() => setTarget(null)}
          intro={<div className="kiu-stack">
            <Field id="m-num" label="Semester number (1–3)" inputMode="numeric" value={sem.number} onChange={(e) => setSem({ ...sem, number: e.target.value })} />
            <div className="kiu-field"><label htmlFor="m-from">Starts</label><input id="m-from" className="kiu-input" type="date" value={sem.startsOn} onChange={(e) => setSem({ ...sem, startsOn: e.target.value })} /></div>
            <div className="kiu-field"><label htmlFor="m-to">Ends</label><input id="m-to" className="kiu-input" type="date" value={sem.endsOn} onChange={(e) => setSem({ ...sem, endsOn: e.target.value })} /></div>
          </div>}
          onConfirm={async (reason) => { await api('POST', `/settings/sessions/${target.session.id}/semesters`, { number: Number(sem.number), startsOn: sem.startsOn, endsOn: sem.endsOn, reason }); s.reload(); }} />
      )}
    </Card>
  );
}
