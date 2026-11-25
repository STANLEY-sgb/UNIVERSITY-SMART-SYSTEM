import { Banner, Button, Card, DataTable, Field, Modal, Pager, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';

interface Session {
  id: string; courseCode: string; courseTitle: string; venueCode: string; venueName: string; capacity: number | null;
  startsAt: string; endsAt: string; entryOpensAt: string; entryClosesAt: string; semester: string; attendanceCount: number; seatCount: number;
}
interface Hall { code: string; name: string; capacity: number | null }
interface Attendance { course: { code: string; title: string }; data: { id: string; regNo: string; fullName: string; status: string; markedAt: string }[]; meta: Paged<unknown>['meta'] }

type When = 'upcoming' | 'past' | 'all';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Exams({ me }: { me: Me }) {
  const [when, setWhen] = useState<When>('upcoming');
  const [page, setPage] = useState(1);
  const list = useApi<Paged<Session>>(`/exams/sessions${qs({ when, page, pageSize: 10 })}`);
  const halls = useApi<Hall[]>('/exams/halls');
  const manage = can(me, 'exams.manage');
  const seeAttendance = can(me, 'exams.attendance.view');
  const [form, setForm] = useState({ courseCode: '', venueCode: '', startsAt: '', endsAt: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<Session | null>(null);
  const [viewing, setViewing] = useState<Session | null>(null);
  const [seating, setSeating] = useState<Session | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setNotice(null);
    try {
      // datetime-local has no zone; it is read as the browser's local time, which is what invigilators see.
      const code = form.courseCode.trim().toUpperCase();
      await api('POST', '/exams/sessions', { ...form, courseCode: code, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString() });
      setNotice(`Scheduled ${code}. Entry opens 60 minutes before the start and closes 30 minutes after.`);
      setForm({ ...form, courseCode: '', reason: '' }); setWhen('upcoming'); setPage(1); list.reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Examinations" />
      {manage && (
        <Card>
          <form className="kiu-stack" onSubmit={create}>
            <div className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 130px' }}><Field id="x-course" label="Course code" value={form.courseCode} onChange={(e) => setForm({ ...form, courseCode: e.target.value })} placeholder="CSC2201" /></div>
              <div className="kiu-field" style={{ flex: '1 1 180px' }}><label htmlFor="x-hall">Examination hall</label>
                <select id="x-hall" className="kiu-input" value={form.venueCode} onChange={(e) => setForm({ ...form, venueCode: e.target.value })}>
                  <option value="">Choose a hall…</option>
                  {(halls.data ?? []).map((h) => <option key={h.code} value={h.code}>{h.name}{h.capacity ? ` (${h.capacity})` : ''}</option>)}
                </select>
              </div>
              <div className="kiu-field" style={{ flex: '1 1 190px' }}><label htmlFor="x-start">Starts</label><input id="x-start" className="kiu-input" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></div>
              <div className="kiu-field" style={{ flex: '1 1 190px' }}><label htmlFor="x-end">Ends</label><input id="x-end" className="kiu-input" type="datetime-local" value={form.endsAt} min={form.startsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
            </div>
            <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 260px' }}><Field id="x-reason" label="Reason / reference (audited)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Timetable approved by senate" /></div>
              <Button type="submit" disabled={busy || !form.courseCode.trim() || !form.venueCode || !form.startsAt || !form.endsAt || form.reason.trim().length < 5} data-testid="exam-create">{busy ? 'Saving…' : 'Schedule examination'}</Button>
            </div>
          </form>
        </Card>
      )}
      {err && <Banner tone="deny">{err}</Banner>}
      {notice && <Banner tone="grant">{notice}</Banner>}
      {list.error && <Banner tone="deny">{list.error}</Banner>}
      <Card>
        <div className="kiu-row" role="group" aria-label="Show">
          {(['upcoming', 'past', 'all'] as When[]).map((w) => <Button key={w} variant={when === w ? 'ink' : 'secondary'} onClick={() => { setWhen(w); setPage(1); }}>{w[0]!.toUpperCase() + w.slice(1)}</Button>)}
        </div>
        {list.loading && !list.data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="exams" rows={list.data?.data ?? []} empty="No examinations in this view." columns={[
              { key: 'course', header: 'Course', render: (s) => <span><strong>{s.courseCode}</strong> {s.courseTitle}</span> },
              { key: 'when', header: 'Sitting', render: (s) => `${fmt(s.startsAt)} – ${hhmm(s.endsAt)}` },
              { key: 'hall', header: 'Hall', render: (s) => s.venueName },
              { key: 'entry', header: 'Entry window', render: (s) => `${hhmm(s.entryOpensAt)}–${hhmm(s.entryClosesAt)}` },
              { key: 'att', header: 'Attended', render: (s) => <StatusChip tone={s.attendanceCount ? 'grant' : 'info'}>{s.attendanceCount}</StatusChip> },
              { key: 'actions', header: 'Actions', render: (s) => (
                <div className="kiu-row">
                  <Button variant="secondary" onClick={() => setSeating(s)} data-testid={`seats-${s.courseCode}`}>Seats</Button>
                  {seeAttendance && <Button variant="secondary" onClick={() => setViewing(s)} data-testid={`attendance-${s.courseCode}`}>Attendance</Button>}
                  {manage && <Button variant="secondary" onClick={() => setCancelling(s)} disabled={s.attendanceCount > 0} data-testid={`cancel-${s.courseCode}`}>Cancel</Button>}
                </div>
              ) },
            ]} />
            {list.data && <Pager page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {cancelling && <ReasonModal title="Cancel examination" intro={`Cancel the ${cancelling.courseCode} examination in ${cancelling.venueName}? Students will no longer be admitted for it.`} confirmLabel="Cancel examination" danger
        onClose={() => setCancelling(null)} onConfirm={async (reason) => { await api('POST', `/exams/sessions/${cancelling.id}/cancel`, { reason }); list.reload(); }} />}
      {seating && <SeatsModal session={seating} manage={manage} onClose={() => setSeating(null)} onChanged={list.reload} />}
      {viewing && <AttendanceModal session={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function AttendanceModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const a = useApi<Attendance>(`/exams/sessions/${session.id}/attendance${qs({ page, pageSize: 10 })}`);
  return (
    <Modal title={`${session.courseCode} attendance`} onClose={onClose}>
      {a.error && <Banner tone="deny">{a.error}</Banner>}
      {a.loading && !a.data ? <Skeleton h={120} /> : (
        <>
          <DataTable testId="exam-attendance" rows={a.data?.data ?? []} empty="Nobody has been admitted yet." columns={[
            { key: 'reg', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo}</span> },
            { key: 'name', header: 'Name', render: (r) => r.fullName },
            { key: 'status', header: 'Status', render: (r) => <StatusChip tone={r.status === 'PRESENT' ? 'grant' : 'warn'}>{r.status}</StatusChip> },
            { key: 'at', header: 'Admitted', render: (r) => fmt(r.markedAt) },
          ]} />
          {a.data && <Pager page={a.data.meta.page} totalPages={a.data.meta.totalPages} total={a.data.meta.total} onPage={setPage} />}
        </>
      )}
      <div className="kiu-row"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

interface SeatView { course: string; venue: string; capacity: number | null; enrolled: number; seated: number; unseated: number; data: { id: string; seatLabel: string; regNo: string; fullName: string }[] }

function SeatsModal({ session, manage, onClose, onChanged }: { session: Session; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const v = useApi<SeatView>(`/exams/sessions/${session.id}/seats`);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const assign = async () => {
    setBusy(true); setErr(null);
    try { await api('POST', `/exams/sessions/${session.id}/seats/auto-assign`, { reason: reason.trim() }); setReason(''); v.reload(); onChanged(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const d = v.data;
  return (
    <Modal title={`${session.courseCode} seating`} onClose={onClose}>
      {v.error && <Banner tone="deny">{v.error}</Banner>}
      {!d ? <Skeleton h={100} /> : (
        <div className="kiu-stack">
          <p style={{ margin: 0 }} data-testid="seat-summary">{d.venue}{d.capacity ? ` (${d.capacity} seats)` : ''} · {d.enrolled} enrolled · <strong>{d.seated} seated</strong> · {d.unseated} without a seat</p>
          {manage && d.unseated > 0 && (
            <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px' }}><Field id="seat-reason" label="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
              <Button onClick={assign} disabled={busy || reason.trim().length < 5} data-testid="seats-auto">{busy ? 'Assigning…' : `Seat ${d.unseated} student${d.unseated === 1 ? '' : 's'}`}</Button>
            </div>
          )}
          {err && <Banner tone="deny">{err}</Banner>}
          <DataTable testId="seat-list" rows={d.data} empty="Nobody has a seat yet." columns={[
            { key: 's', header: 'Seat', render: (r) => <strong>{r.seatLabel}</strong> },
            { key: 'r', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo}</span> },
            { key: 'n', header: 'Name', render: (r) => r.fullName },
          ]} />
        </div>
      )}
      <div className="kiu-row"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}
