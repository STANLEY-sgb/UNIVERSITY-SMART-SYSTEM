import { Banner, Button, Card, DataTable, Field, Modal, Pager, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';

// ───────────────────────── Departments & Programmes ─────────────────────────

interface Department { id: string; code: string; name: string; faculty: string; programmes: number }
interface Programme { id: string; code: string; name: string; departmentCode: string; durationYears: number }

export function Academic({ me }: { me: Me }) {
  const depts = useApi<Department[]>('/departments');
  const progs = useApi<Programme[]>('/programmes');
  const manage = can(me, 'registry.manage');

  const [df, setDf] = useState({ code: '', name: '', faculty: '' });
  const [dErr, setDErr] = useState<string | null>(null);
  const [dBusy, setDBusy] = useState(false);
  const addDepartment = async (e: React.FormEvent) => {
    e.preventDefault(); setDBusy(true); setDErr(null);
    try { await api('POST', '/departments', { code: df.code.trim().toUpperCase(), name: df.name.trim(), faculty: df.faculty.trim() }); setDf({ code: '', name: '', faculty: '' }); depts.reload(); }
    catch (x) { setDErr(errText(x)); } finally { setDBusy(false); }
  };

  const [pf, setPf] = useState({ code: '', name: '', departmentCode: '', durationYears: '3' });
  const [pErr, setPErr] = useState<string | null>(null);
  const [pBusy, setPBusy] = useState(false);
  const addProgramme = async (e: React.FormEvent) => {
    e.preventDefault(); setPBusy(true); setPErr(null);
    try {
      await api('POST', '/programmes', { code: pf.code.trim().toUpperCase(), name: pf.name.trim(), departmentCode: pf.departmentCode, durationYears: Number(pf.durationYears) });
      setPf({ code: '', name: '', departmentCode: pf.departmentCode, durationYears: '3' }); progs.reload(); depts.reload();
    } catch (x) { setPErr(errText(x)); } finally { setPBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Departments & Programmes" />
      <Card className="kiu-stack">
        <h2>Departments</h2>
        {manage && (
          <form className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={addDepartment}>
            <div style={{ flex: '1 1 100px' }}><Field id="d-code" label="Code" value={df.code} onChange={(e) => setDf({ ...df, code: e.target.value })} placeholder="CS" /></div>
            <div style={{ flex: '2 1 200px' }}><Field id="d-name" label="Name" value={df.name} onChange={(e) => setDf({ ...df, name: e.target.value })} placeholder="Computer Science" /></div>
            <div style={{ flex: '2 1 200px' }}><Field id="d-faculty" label="Faculty" value={df.faculty} onChange={(e) => setDf({ ...df, faculty: e.target.value })} placeholder="Science & Technology" /></div>
            <Button type="submit" disabled={dBusy || df.code.trim().length < 2 || df.name.trim().length < 2 || df.faculty.trim().length < 2} data-testid="department-add">{dBusy ? 'Saving…' : 'Add department'}</Button>
          </form>
        )}
        {dErr && <Banner tone="deny">{dErr}</Banner>}
        {depts.error && <Banner tone="deny">{depts.error}</Banner>}
        {depts.loading && !depts.data ? <Skeleton h={100} /> : (
          <DataTable testId="departments" rows={depts.data ?? []} empty="No departments yet." columns={[
            { key: 'c', header: 'Code', render: (x) => <span className="mono">{x.code}</span> },
            { key: 'n', header: 'Name', render: (x) => x.name },
            { key: 'f', header: 'Faculty', render: (x) => x.faculty },
            { key: 'p', header: 'Programmes', render: (x) => x.programmes },
          ]} />
        )}
      </Card>
      <Card className="kiu-stack">
        <h2>Programmes</h2>
        {manage && (
          <form className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={addProgramme}>
            <div style={{ flex: '1 1 100px' }}><Field id="p-code" label="Code" value={pf.code} onChange={(e) => setPf({ ...pf, code: e.target.value })} placeholder="BCS" /></div>
            <div style={{ flex: '2 1 220px' }}><Field id="p-name" label="Name" value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} placeholder="BSc Computer Science" /></div>
            <div className="kiu-field" style={{ flex: '1 1 160px' }}><label htmlFor="p-dept">Department</label>
              <select id="p-dept" className="kiu-input" value={pf.departmentCode} onChange={(e) => setPf({ ...pf, departmentCode: e.target.value })}>
                <option value="">Choose…</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.code}>{d.code} · {d.name}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 90px' }}><Field id="p-dur" label="Duration (yrs)" inputMode="numeric" value={pf.durationYears} onChange={(e) => setPf({ ...pf, durationYears: e.target.value })} /></div>
            <Button type="submit" disabled={pBusy || pf.code.trim().length < 2 || pf.name.trim().length < 2 || !pf.departmentCode || !(Number(pf.durationYears) >= 1 && Number(pf.durationYears) <= 8)} data-testid="programme-add">{pBusy ? 'Saving…' : 'Add programme'}</Button>
          </form>
        )}
        {pErr && <Banner tone="deny">{pErr}</Banner>}
        {progs.error && <Banner tone="deny">{progs.error}</Banner>}
        {progs.loading && !progs.data ? <Skeleton h={100} /> : (
          <DataTable testId="programmes" rows={progs.data ?? []} empty="No programmes yet." columns={[
            { key: 'c', header: 'Code', render: (x) => <span className="mono">{x.code}</span> },
            { key: 'n', header: 'Name', render: (x) => x.name },
            { key: 'd', header: 'Department', render: (x) => x.departmentCode },
            { key: 'y', header: 'Duration', render: (x) => `${x.durationYears} yr${x.durationYears === 1 ? '' : 's'}` },
          ]} />
        )}
      </Card>
    </div>
  );
}

// ───────────────────────── Hostels ─────────────────────────

interface Hostel { id: string; code: string; name: string; venueCode: string; residents: number }
interface Allocation { id: string; roomNo: string | null; allocatedAt: string; hostel: { code: string; name: string }; student: { regNo: string; fullName: string } }

export function Hostels({ me }: { me: Me }) {
  const [hostel, setHostel] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ regNo: '', hostelCode: '', roomNo: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<Allocation | null>(null);
  const hostels = useApi<Hostel[]>('/hostels');
  const { data, error, loading, reload } = useApi<Paged<Allocation>>(`/hostels/allocations${qs({ hostel: hostel || undefined, page, pageSize: 15 })}`);
  const manage = can(me, 'hostel.manage');

  const allocate = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setNotice(null);
    try {
      await api('POST', '/hostels/allocations', { regNo: form.regNo.trim(), hostelCode: form.hostelCode, roomNo: form.roomNo.trim() || undefined, reason: form.reason.trim() });
      setNotice(`${form.regNo.trim().toUpperCase()} allocated to ${form.hostelCode}. Access applies from the next scan.`);
      setForm({ regNo: '', hostelCode: form.hostelCode, roomNo: '', reason: '' }); reload(); hostels.reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Hostels" />
      {hostels.data && <div className="kiu-row">{hostels.data.map((h) => <StatusChip key={h.id} tone="info">{h.name}: {h.residents} residents</StatusChip>)}</div>}
      {manage && (
        <Card>
          <form className="kiu-stack" onSubmit={allocate}>
            <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 180px' }}><Field id="h-reg" label="Registration no." value={form.regNo} onChange={(e) => setForm({ ...form, regNo: e.target.value })} /></div>
              <div className="kiu-field" style={{ flex: '1 1 140px' }}><label htmlFor="h-host">Hostel</label>
                <select id="h-host" className="kiu-input" value={form.hostelCode} onChange={(e) => setForm({ ...form, hostelCode: e.target.value })}>
                  <option value="">Choose…</option>{hostels.data?.map((h) => <option key={h.id} value={h.code}>{h.name}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 100px' }}><Field id="h-room" label="Room (optional)" value={form.roomNo} onChange={(e) => setForm({ ...form, roomNo: e.target.value })} /></div>
            </div>
            <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 260px' }}><Field id="h-reason" label="Reason (audited, 5+ characters)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
              <Button type="submit" disabled={busy || !form.regNo.trim() || !form.hostelCode || form.reason.trim().length < 5} data-testid="allocate-submit">{busy ? 'Saving…' : 'Allocate'}</Button>
            </div>
          </form>
        </Card>
      )}
      {notice && <Banner tone="grant">{notice}</Banner>}
      {err && <Banner tone="deny">{err}</Banner>}
      <Card>
        <div className="kiu-filters">
          <div className="kiu-field"><label htmlFor="h-filter">Hostel</label>
            <select id="h-filter" className="kiu-input" value={hostel} onChange={(e) => { setHostel(e.target.value); setPage(1); }}>
              <option value="">All</option>{hostels.data?.map((h) => <option key={h.id} value={h.code}>{h.name}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="allocations" rows={data?.data ?? []} empty="No residents." columns={[
              { key: 'student', header: 'Student', render: (a) => `${a.student.fullName} (${a.student.regNo})` },
              { key: 'hostel', header: 'Hostel', render: (a) => a.hostel.name },
              { key: 'room', header: 'Room', render: (a) => a.roomNo ?? '—' },
              { key: 'actions', header: 'Actions', render: (a) => manage ? <Button variant="secondary" onClick={() => setEnding(a)} data-testid={`end-${a.student.regNo}`}>End allocation</Button> : null },
            ]} />
            {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {ending && <ReasonModal title="End allocation" intro={`Remove ${ending.student.fullName} from ${ending.hostel.name}? Hostel readers will refuse them from the next scan.`} confirmLabel="End allocation" danger
        onClose={() => setEnding(null)} onConfirm={async (reason) => { await api('POST', `/hostels/allocations/${ending.id}/end`, { reason }); reload(); hostels.reload(); }} />}
    </div>
  );
}

// ───────────────────────── Meal sittings ─────────────────────────

interface Sitting { id: string; mealType: string; startsAt: string; endsAt: string }

function SittingModal({ s, onClose, onSaved }: { s: Sitting; onClose: () => void; onSaved: () => void }) {
  const [from, setFrom] = useState(s.startsAt);
  const [to, setTo] = useState(s.endsAt);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('PATCH', `/cafeteria/sittings/${s.id}`, { startsAt: from, endsAt: to, reason: reason.trim() }); onSaved(); onClose(); } catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return (
    <Modal title={`${s.mealType.toLowerCase()} sitting`} onClose={onClose}>
      <form className="kiu-stack" onSubmit={submit}>
        <div>Times use the server clock. One meal per student per sitting per day.</div>
        <Field id="s-from" label="Starts (HH:MM)" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field id="s-to" label="Ends (HH:MM)" value={to} onChange={(e) => setTo(e.target.value)} />
        <Field id="s-reason" label="Reason (audited, 5+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row">
          <Button type="submit" disabled={busy || reason.trim().length < 5} data-testid="sitting-save">{busy ? 'Saving…' : 'Save window'}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Meals({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<Sitting[]>('/cafeteria/sittings');
  const [edit, setEdit] = useState<Sitting | null>(null);
  const manage = can(me, 'cafeteria.manage');
  return (
    <div className="kiu-stack">
      <PageHeader title="Meal sittings" />
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={120} /> : (
          <DataTable testId="sittings" rows={data ?? []} empty="No sittings configured." columns={[
            { key: 'meal', header: 'Meal', render: (s) => s.mealType },
            { key: 'from', header: 'From', render: (s) => s.startsAt },
            { key: 'to', header: 'Until', render: (s) => s.endsAt },
            { key: 'actions', header: 'Actions', render: (s) => manage ? <Button variant="secondary" onClick={() => setEdit(s)} data-testid={`sitting-${s.mealType}`}>Change window</Button> : null },
          ]} />
        )}
      </Card>
      {edit && <SittingModal s={edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

// ───────────────────────── Lecture timetable ─────────────────────────

interface Lecture { id: string; dayOfWeek: number; startsAt: string; endsAt: string; courseCode: string; courseTitle: string; venueCode: string; venueName: string }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Timetable({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<Lecture[]>('/lectures');
  const [form, setForm] = useState({ courseCode: '', venueCode: '', dayOfWeek: '1', startsAt: '', endsAt: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Lecture | null>(null);
  const manage = can(me, 'registry.manage');

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', '/lectures', { ...form, courseCode: form.courseCode.trim().toUpperCase(), venueCode: form.venueCode.trim().toUpperCase(), dayOfWeek: Number(form.dayOfWeek) }); setForm({ ...form, courseCode: '', startsAt: '', endsAt: '' }); reload(); }
    catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Lecture timetable" />
      {manage && (
        <Card>
          <form className="kiu-row" style={{ alignItems: 'flex-end' }} onSubmit={add}>
            <div style={{ flex: '1 1 120px' }}><Field id="t-course" label="Course code" value={form.courseCode} onChange={(e) => setForm({ ...form, courseCode: e.target.value })} placeholder="CSC2201" /></div>
            <div style={{ flex: '1 1 100px' }}><Field id="t-venue" label="Room code" value={form.venueCode} onChange={(e) => setForm({ ...form, venueCode: e.target.value })} placeholder="LH-1" /></div>
            <div className="kiu-field" style={{ flex: '1 1 120px' }}><label htmlFor="t-day">Day</label>
              <select id="t-day" className="kiu-input" value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: e.target.value })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
            </div>
            <div style={{ flex: '1 1 90px' }}><Field id="t-from" label="From (HH:MM)" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></div>
            <div style={{ flex: '1 1 90px' }}><Field id="t-to" label="Until (HH:MM)" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
            <Button type="submit" disabled={busy || !form.courseCode.trim() || !form.venueCode.trim() || !form.startsAt || !form.endsAt} data-testid="lecture-add">{busy ? 'Saving…' : 'Add lecture'}</Button>
          </form>
        </Card>
      )}
      {err && <Banner tone="deny">{err}</Banner>}
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <DataTable testId="lectures" rows={data ?? []} empty="No lectures scheduled." columns={[
            { key: 'day', header: 'Day', render: (l) => DAYS[l.dayOfWeek] },
            { key: 'time', header: 'Time', render: (l) => `${l.startsAt}–${l.endsAt}` },
            { key: 'course', header: 'Course', render: (l) => `${l.courseCode} ${l.courseTitle}` },
            { key: 'room', header: 'Room', render: (l) => l.venueName },
            { key: 'actions', header: 'Actions', render: (l) => manage ? <Button variant="secondary" onClick={() => setRemoving(l)} data-testid={`remove-${l.courseCode}-${l.dayOfWeek}`}>Remove</Button> : null },
          ]} />
        )}
      </Card>
      {removing && <ReasonModal title="Remove lecture" intro={`Remove ${removing.courseCode} on ${DAYS[removing.dayOfWeek]} ${removing.startsAt}? A lecture with recorded attendance cannot be removed.`} confirmLabel="Remove lecture" danger
        onClose={() => setRemoving(null)} onConfirm={async (reason) => { await api('POST', `/lectures/${removing.id}/remove`, { reason }); reload(); }} />}
    </div>
  );
}
