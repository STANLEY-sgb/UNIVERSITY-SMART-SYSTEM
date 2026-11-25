import { Banner, Button, Card, DataTable, Field, Modal, Pager, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, SecretModal, errText } from '../components/Common';

interface Row { id: string; regNo: string; fullName: string; yearOfStudy: number; accountStatus: string; programme: { code: string; name: string }; cards: { cardNumber: string; status: string }[] }
interface Overview {
  student: { id: string; regNo: string; fullName: string; email: string | null; phone: string | null; yearOfStudy: number; accountStatus: string; programme: { code: string; name: string } };
  cards: { id: string; cardNumber: string; status: string; issuedAt: string | null; expiresAt: string }[] | null;
  facts: Record<string, unknown> | null;
  enrolments: { code: string; title: string }[];
  activeLoans: number;
  hostel: { name: string; room: string | null } | null;
  recentAccess: { id: string; occurredAt: string; decision: 'GRANT' | 'DENY'; reasonCode: string; offline: boolean; service: { name: string } | null }[] | null;
}

const STATUS_TONE = { ACTIVE: 'grant', SUSPENDED: 'deny', WITHDRAWN: 'warn', GRADUATED: 'info' } as const;

function CreateStudentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (regNo: string) => void }) {
  const programmes = useApi<{ id: string; code: string; name: string }[]>('/programmes');
  const [f, setF] = useState({ regNo: '', fullName: '', programmeId: '', yearOfStudy: '1', email: '', phone: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api('POST', '/students', { regNo: f.regNo.trim(), fullName: f.fullName.trim(), programmeId: f.programmeId, yearOfStudy: Number(f.yearOfStudy), ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}) });
      onCreated(f.regNo.trim().toUpperCase()); onClose();
    } catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return (
    <Modal title="Register a student" onClose={onClose}>
      <form className="kiu-stack" onSubmit={submit}>
        <Banner tone="info">The student starts with nothing cleared: Finance and the Registry must confirm fees and registration before services open.</Banner>
        <Field id="ns-reg" label="Registration number" value={f.regNo} onChange={(e) => setF({ ...f, regNo: e.target.value })} placeholder="2026-BCS-0100" autoComplete="off" />
        <Field id="ns-name" label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <div className="kiu-field"><label htmlFor="ns-prog">Programme</label>
          <select id="ns-prog" className="kiu-input" value={f.programmeId} onChange={(e) => setF({ ...f, programmeId: e.target.value })}>
            <option value="">Choose…</option>{(programmes.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </select>
        </div>
        <Field id="ns-year" label="Year of study (1–7)" inputMode="numeric" value={f.yearOfStudy} onChange={(e) => setF({ ...f, yearOfStudy: e.target.value })} />
        <Field id="ns-email" label="Email (optional)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Field id="ns-phone" label="Phone (optional)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row">
          <Button type="submit" disabled={busy || f.regNo.trim().length < 4 || f.fullName.trim().length < 2 || !f.programmeId || !(Number(f.yearOfStudy) >= 1 && Number(f.yearOfStudy) <= 7)} data-testid="student-create">{busy ? 'Saving…' : 'Register student'}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Students({ me }: { me: Me }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading } = useApi<Paged<Row>>(`/students${qs({ q: q.trim() || undefined, accountStatus: status || undefined, page, pageSize: 15 })}`);

  return (
    <div className="kiu-stack">
      <PageHeader title="Students">
        {can(me, 'students.create') && <Button onClick={() => setCreating(true)} data-testid="student-new">Register student</Button>}
      </PageHeader>
      {created && <Banner tone="grant">Registered {created}. Search for them to issue a card.</Banner>}
      <Card>
        <div className="kiu-filters">
          <Field id="q" label="Search name or registration no." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="e.g. 2026-BCS-0001" />
          <div className="kiu-field"><label htmlFor="status">Account status</label>
            <select id="status" className="kiu-input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>{['ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="students" rows={data?.data ?? []} onRowClick={(r) => setOpen(r.id)} empty="No students match." columns={[
              { key: 'regNo', header: 'Reg. no.', render: (r) => <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{r.regNo}</button> },
              { key: 'fullName', header: 'Name' },
              { key: 'programme', header: 'Programme', render: (r) => r.programme.code },
              { key: 'yearOfStudy', header: 'Year' },
              { key: 'accountStatus', header: 'Status', render: (r) => <StatusChip tone={STATUS_TONE[r.accountStatus as keyof typeof STATUS_TONE] ?? 'info'}>{r.accountStatus}</StatusChip> },
              { key: 'cards', header: 'Active card', render: (r) => r.cards[0]?.cardNumber ?? <span className="muted">none</span> },
            ]} />
            {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {creating && <CreateStudentModal onClose={() => setCreating(false)} onCreated={(r) => { setCreated(r); setQ(r); setPage(1); }} />}
      {open && <StudentModal id={open} me={me} onClose={() => setOpen(null)} />}
    </div>
  );
}

function StudentModal({ id, me, onClose }: { id: string; me: Me; onClose: () => void }) {
  const { data, error, reload } = useApi<Overview>(`/students/${id}/overview`);
  const [issued, setIssued] = useState<{ code: string; cardNumber: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (issued) {
    return <SecretModal title="Card issued" onClose={() => { setIssued(null); reload(); }}
      note="Give this one-time code to the student. It is shown only now and expires in 72 hours."
      secrets={[{ label: 'Activation code', value: issued.code }, { label: 'Card number', value: issued.cardNumber }]} />;
  }
  const issue = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ card: { cardNumber: string }; activationCode: string }>('POST', '/cards', { regNo: data!.student.regNo }); setIssued({ code: r.activationCode, cardNumber: r.card.cardNumber }); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const hasActive = data?.cards?.some((c) => c.status === 'ACTIVE');

  return (
    <Modal title={data ? data.student.fullName : 'Student'} onClose={onClose} wide>
      {error && <Banner tone="deny">{error}</Banner>}
      {!data && !error && <Skeleton h={120} />}
      {data && (
        <div className="kiu-stack" data-testid="student-detail">
          <div className="kiu-row"><span className="mono">{data.student.regNo}</span><StatusChip tone={STATUS_TONE[data.student.accountStatus as keyof typeof STATUS_TONE] ?? 'info'}>{data.student.accountStatus}</StatusChip>
            <span>{data.student.programme.name} · Year {data.student.yearOfStudy}</span></div>
          <div className="kiu-grid cols-2">
            <Card flat className="kiu-stack">
              <h3>Enrolled course units</h3>
              {data.enrolments.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{data.enrolments.map((e) => <li key={e.code}><span className="mono">{e.code}</span> {e.title}</li>)}</ul> : <p className="muted">None this semester.</p>}
              <p className="muted">Hostel: {data.hostel ? `${data.hostel.name}${data.hostel.room ? ` · ${data.hostel.room}` : ''}` : 'not allocated'} · Active loans: {data.activeLoans}</p>
            </Card>
            {data.facts ? (
              <Card flat className="kiu-stack" data-testid="facts">
                <h3>Eligibility facts</h3>
                <dl className="kiu-grid" style={{ margin: 0, gridTemplateColumns: '1fr 1fr' }}>
                  {Object.entries(data.facts).filter(([k]) => k !== 'enrolled_course_units').map(([k, v]) => <div key={k}><dt className="muted mono">{k}</dt><dd style={{ margin: 0, fontWeight: 700 }}>{String(v)}</dd></div>)}
                </dl>
              </Card>
            ) : <Card flat><h3>Eligibility facts</h3><p className="muted">Your role does not include financial or registry data.</p></Card>}
          </div>

          {data.cards && (
            <Card flat className="kiu-stack">
              <div className="kiu-row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Cards</h3>
                {can(me, 'cards.issue') && !hasActive && data.student.accountStatus === 'ACTIVE' && <Button onClick={issue} disabled={busy} data-testid="issue-card">{busy ? 'Issuing…' : 'Issue card'}</Button>}</div>
              {err && <Banner tone="deny">{err}</Banner>}
              <DataTable rows={data.cards} empty="No cards yet." columns={[
                { key: 'cardNumber', header: 'Card', render: (c) => <span className="mono">{c.cardNumber}</span> },
                { key: 'status', header: 'Status', render: (c) => <StatusChip tone={c.status === 'ACTIVE' ? 'grant' : c.status === 'PENDING' ? 'warn' : 'deny'}>{c.status}</StatusChip> },
                { key: 'expiresAt', header: 'Expires', render: (c) => fmt(c.expiresAt) },
              ]} />
              <p className="kiu-hint">Block, report lost or replace from the Cards page.</p>
            </Card>
          )}

          {data.recentAccess && (
            <Card flat className="kiu-stack">
              <h3>Recent access</h3>
              <DataTable rows={data.recentAccess} empty="No access recorded." columns={[
                { key: 'occurredAt', header: 'When', render: (r) => fmt(r.occurredAt) }, { key: 'service', header: 'Service', render: (r) => r.service?.name ?? '—' },
                { key: 'decision', header: 'Result', render: (r) => <StatusChip tone={r.decision === 'GRANT' ? 'grant' : 'deny'}>{r.decision}</StatusChip> },
                { key: 'reasonCode', header: 'Reason', render: (r) => <span className="mono">{r.reasonCode}{r.offline ? ' · offline' : ''}</span> },
              ]} />
            </Card>
          )}
        </div>
      )}
    </Modal>
  );
}
