import { Banner, Button, Card, DataTable, Field, Modal, Pager, Skeleton, StatusChip, TextArea } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, errText } from '../components/Common';

interface FinanceRow { id: string; regNo: string; fullName: string; programme: string; feesPaidPercent: number; examCleared: boolean; updatedAt: string }

function FinanceModal({ row, onClose, onSaved }: { row: FinanceRow; onClose: () => void; onSaved: () => void }) {
  const [fees, setFees] = useState(String(row.feesPaidPercent));
  const [cleared, setCleared] = useState(row.examCleared);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const feesNum = Number(fees);
  const feesOk = fees.trim() !== '' && Number.isFinite(feesNum) && feesNum >= 0 && feesNum <= 100;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api('PATCH', `/finance/students/${encodeURIComponent(row.regNo)}`, { feesPaidPercent: feesNum, examCleared: cleared, reason: reason.trim() });
      onSaved(); onClose();
    } catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return (
    <Modal title={`Finance status: ${row.regNo}`} onClose={onClose}>
      <form className="kiu-stack" onSubmit={submit}>
        <div>{row.fullName}. The next access decision uses these values immediately.</div>
        <Field id="fees" label="Fees paid (%)" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} error={fees && !feesOk ? 'Enter a number from 0 to 100' : null} />
        <label className="kiu-row" style={{ minHeight: 44, alignItems: 'center' }}>
          <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} data-testid="cleared-toggle" /> Cleared for examinations
        </label>
        <TextArea id="reason" label="Reason (recorded in the audit trail, 5+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row">
          <Button type="submit" disabled={!feesOk || reason.trim().length < 5 || busy} data-testid="finance-save">{busy ? 'Saving…' : 'Save status'}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Finance({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [clearance, setClearance] = useState('');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<FinanceRow | null>(null);
  const { data, error, loading, reload } = useApi<Paged<FinanceRow>>(`/finance/students${qs({ q: q.trim() || undefined, clearance: clearance || undefined, page, pageSize: 15 })}`);
  const canEdit = can(me, 'finance.update');
  return (
    <div className="kiu-stack">
      <PageHeader title="Finance clearance" />
      <Card>
        <div className="kiu-filters">
          <Field id="fq" label="Search name or registration no." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <div className="kiu-field"><label htmlFor="fclear">Clearance</label>
            <select id="fclear" className="kiu-input" value={clearance} onChange={(e) => { setClearance(e.target.value); setPage(1); }}>
              <option value="">All</option><option value="cleared">Cleared</option><option value="pending">Not cleared</option>
            </select>
          </div>
        </div>
      </Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="finance" rows={data?.data ?? []} empty="No students match." columns={[
              { key: 'regNo', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo}</span> },
              { key: 'fullName', header: 'Name', render: (r) => r.fullName },
              { key: 'programme', header: 'Programme', render: (r) => r.programme },
              { key: 'fees', header: 'Fees paid', render: (r) => `${r.feesPaidPercent}%` },
              { key: 'cleared', header: 'Exam clearance', render: (r) => <StatusChip tone={r.examCleared ? 'grant' : 'deny'}>{r.examCleared ? 'Cleared' : 'Not cleared'}</StatusChip> },
              { key: 'updatedAt', header: 'Updated', render: (r) => fmt(r.updatedAt) },
              { key: 'actions', header: 'Actions', render: (r) => canEdit ? <Button variant="secondary" onClick={() => setEdit(r)} data-testid={`finance-edit-${r.regNo}`}>Update</Button> : null },
            ]} />
            {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {edit && <FinanceModal row={edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

interface LoanRow { id: string; itemRef: string; title: string; borrowedAt: string; dueAt: string; returnedAt: string | null; status: 'ACTIVE' | 'OVERDUE' | 'RETURNED'; student: { regNo: string; fullName: string } }
const LOAN_TONE = { ACTIVE: 'info', OVERDUE: 'deny', RETURNED: 'grant' } as const;

export function Library({ me }: { me: Me }) {
  const [reg, setReg] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [lend, setLend] = useState({ regNo: '', itemRef: '', title: '' });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useApi<Paged<LoanRow>>(`/library/loans${qs({ regNo: reg.trim() || undefined, status: status || undefined, page, pageSize: 15 })}`);
  const canManage = can(me, 'library.manage');

  const lendBook = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormErr(null); setNotice(null);
    try {
      await api('POST', '/library/loans', { regNo: lend.regNo.trim(), itemRef: lend.itemRef.trim(), title: lend.title.trim() });
      setNotice(`Loan recorded for ${lend.regNo.trim().toUpperCase()}.`); setLend({ regNo: '', itemRef: '', title: '' }); reload();
    } catch (x) { setFormErr(errText(x)); } finally { setBusy(false); }
  };
  const giveBack = async (l: LoanRow) => {
    setFormErr(null); setNotice(null);
    try {
      const r = await api<{ overdueItemsNow: number }>('POST', `/library/loans/${l.id}/return`, {});
      setNotice(r.overdueItemsNow === 0 ? `${l.student.regNo}: all overdue items cleared. Borrowing is open again.` : `${l.student.regNo}: ${r.overdueItemsNow} overdue item(s) remain.`);
      reload();
    } catch (x) { setFormErr(errText(x)); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Library loans" />
      {canManage && (
        <Card>
          <form className="kiu-row" style={{ alignItems: 'flex-end' }} onSubmit={lendBook}>
            <div style={{ flex: '1 1 180px' }}><Field id="l-reg" label="Registration no." value={lend.regNo} onChange={(e) => setLend({ ...lend, regNo: e.target.value })} /></div>
            <div style={{ flex: '1 1 140px' }}><Field id="l-ref" label="Item reference" value={lend.itemRef} onChange={(e) => setLend({ ...lend, itemRef: e.target.value })} placeholder="BK-000123" /></div>
            <div style={{ flex: '2 1 220px' }}><Field id="l-title" label="Title" value={lend.title} onChange={(e) => setLend({ ...lend, title: e.target.value })} /></div>
            <Button type="submit" disabled={busy || !lend.regNo.trim() || !lend.itemRef.trim() || lend.title.trim().length < 2} data-testid="lend-submit">{busy ? 'Saving…' : 'Record loan'}</Button>
          </form>
        </Card>
      )}
      {notice && <Banner tone="grant" data-testid="library-notice">{notice}</Banner>}
      {formErr && <Banner tone="deny" data-testid="library-error">{formErr}</Banner>}
      <Card>
        <div className="kiu-filters">
          <Field id="lreg" label="Filter by registration no." value={reg} onChange={(e) => { setReg(e.target.value); setPage(1); }} />
          <div className="kiu-field"><label htmlFor="lstatus">Status</label>
            <select id="lstatus" className="kiu-input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>{['ACTIVE', 'OVERDUE', 'RETURNED'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="loans" rows={data?.data ?? []} empty="No loans match." columns={[
              { key: 'student', header: 'Student', render: (l) => `${l.student.fullName} (${l.student.regNo})` },
              { key: 'item', header: 'Item', render: (l) => <span><span className="mono">{l.itemRef}</span> {l.title}</span> },
              { key: 'dueAt', header: 'Due', render: (l) => fmt(l.dueAt) },
              { key: 'status', header: 'Status', render: (l) => <StatusChip tone={LOAN_TONE[l.status]}>{l.status}</StatusChip> },
              { key: 'actions', header: 'Actions', render: (l) => canManage && l.status !== 'RETURNED' ? <Button variant="secondary" onClick={() => giveBack(l)} data-testid={`return-${l.itemRef}`}>Mark returned</Button> : null },
            ]} />
            {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </div>
  );
}
