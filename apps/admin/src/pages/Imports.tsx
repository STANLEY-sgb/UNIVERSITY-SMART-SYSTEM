import { Banner, Button, Card, DataTable, Pager, Skeleton, StatusChip, TextArea } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';
import { MAX_XLSX_BYTES, XlsxError, xlsxToCsv } from '../lib/xlsx';

type Kind = 'FINANCE' | 'REGISTRY' | 'LIBRARY';
const KINDS: { kind: Kind; label: string; perm: string; columns: string; example: string }[] = [
  { kind: 'FINANCE', label: 'Finance clearance', perm: 'finance.update', columns: 'reg_no, fees_paid_percent, exam_cleared', example: 'reg_no,fees_paid_percent,exam_cleared\n2026-BCS-0001,100,yes' },
  { kind: 'REGISTRY', label: 'Registration', perm: 'registry.manage', columns: 'reg_no, semester_registered', example: 'reg_no,semester_registered\n2026-BCS-0001,yes' },
  { kind: 'LIBRARY', label: 'Library fines', perm: 'library.manage', columns: 'reg_no, fine_ugx', example: 'reg_no,fine_ugx\n2026-BCS-0001,0' },
];

interface Row { line: number; regNo: string; status: 'OK' | 'UNCHANGED' | 'ERROR'; errors: string[]; before?: Record<string, unknown>; after?: Record<string, unknown> }
interface Preview { sha256: string; summary: { total: number; ok: number; unchanged: number; errors: number }; alreadyImported: { jobId: string } | null; rows: Row[]; rowsShown: number }
interface Job { id: string; kind: string; status: string; rowsTotal: number; rowsOk: number; rowsFailed: number; startedAt: string }

const show = (o?: Record<string, unknown>) => (o ? Object.entries(o).map(([k, v]) => `${k}: ${String(v)}`).join(', ') : '');
const TONE = { OK: 'grant', UNCHANGED: 'info', ERROR: 'deny' } as const;

export function Imports({ me }: { me: Me }) {
  const allowed = KINDS.filter((k) => can(me, k.perm));
  const [kind, setKind] = useState<Kind>(allowed[0]?.kind ?? 'FINANCE');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [page, setPage] = useState(1);
  const jobs = useApi<Paged<Job>>(`/imports/jobs${qs({ page, pageSize: 8 })}`);
  const spec = KINDS.find((k) => k.kind === kind)!;

  const reset = () => { setPreview(null); setErr(null); setNotice(null); };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 200 * 1024) { setErr('That file is larger than 200 KB.'); return; }
    reset();
    if (/\.xlsx$/i.test(f.name)) {
      // Converted here, in the browser: the server still receives plain CSV and shows the same preview.
      try {
        if (f.size > MAX_XLSX_BYTES) throw new XlsxError('That file is larger than 200 KB.');
        setCsv(xlsxToCsv(new Uint8Array(await f.arrayBuffer())));
        setNotice(`Read the first sheet of ${f.name}. Check the preview, then apply.`);
      } catch (x) { setErr(x instanceof XlsxError ? x.message : 'That workbook could not be read.'); }
      return;
    }
    setCsv(await f.text());
  };
  const runPreview = async () => {
    setBusy(true); reset();
    try { setPreview(await api<Preview>('POST', '/imports/preview', { kind, csv })); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const commit = async (reason: string) => {
    const r = await api<{ summary: { ok: number; errors: number } }>('POST', '/imports/commit', { kind, csv, reason, expectedSha256: preview!.sha256 });
    setNotice(`Import finished: ${r.summary.ok} row(s) applied, ${r.summary.errors} skipped. Changes apply from the next scan.`);
    setPreview(null); setCsv(''); jobs.reload();
  };

  if (!allowed.length) return <div className="kiu-stack"><PageHeader title="Data imports" /><Banner tone="warn">Your role cannot import any dataset.</Banner></div>;

  return (
    <div className="kiu-stack">
      <PageHeader title="Data imports" />
      <Card>
        <div className="kiu-stack">
          <div className="kiu-field"><label htmlFor="imp-kind">Dataset</label>
            <select id="imp-kind" className="kiu-input" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setCsv(''); reset(); }}>
              {allowed.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <div>Columns: <span className="mono">{spec.columns}</span>. One header row, up to 1000 rows. Excel (.xlsx) files are read from their first sheet. Nothing is changed until you review the preview and confirm.</div>
          <div className="kiu-field"><label htmlFor="imp-file">CSV or Excel file</label><input id="imp-file" className="kiu-input" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e.target.files?.[0])} /></div>
          <TextArea id="imp-text" label="…or paste CSV text" value={csv} onChange={(e) => { setCsv(e.target.value); reset(); }} placeholder={spec.example} />
          <div className="kiu-row"><Button onClick={runPreview} disabled={busy || csv.trim().length < 3} data-testid="import-preview">{busy ? 'Checking…' : 'Preview'}</Button></div>
        </div>
      </Card>
      {err && <Banner tone="deny">{err}</Banner>}
      {notice && <Banner tone="grant">{notice}</Banner>}
      {preview && (
        <Card>
          <div className="kiu-stack" data-testid="import-summary">
            <div className="kiu-row">
              <StatusChip tone="grant">{preview.summary.ok} will change</StatusChip>
              <StatusChip tone="info">{preview.summary.unchanged} unchanged</StatusChip>
              <StatusChip tone={preview.summary.errors ? 'deny' : 'info'}>{preview.summary.errors} with errors</StatusChip>
            </div>
            {preview.alreadyImported && <Banner tone="warn">This exact file was already imported; committing it again is refused.</Banner>}
            <DataTable testId="import-rows" rows={preview.rows.map((r) => ({ ...r, id: String(r.line) }))} empty="No rows." columns={[
              { key: 'line', header: 'Line', render: (r) => r.line },
              { key: 'regNo', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo || '—'}</span> },
              { key: 'status', header: 'Result', render: (r) => <StatusChip tone={TONE[r.status]}>{r.status}</StatusChip> },
              { key: 'detail', header: 'Detail', render: (r) => r.errors.length ? r.errors.join('; ') : r.status === 'OK' ? `${show(r.before)} → ${show(r.after)}` : 'No change' },
            ]} />
            {preview.rowsShown < preview.summary.total && <div>Showing the first {preview.rowsShown} of {preview.summary.total} rows.</div>}
            <div className="kiu-row">
              <Button onClick={() => setConfirm(true)} disabled={preview.summary.ok === 0 || !!preview.alreadyImported} data-testid="import-commit">Apply {preview.summary.ok} change{preview.summary.ok === 1 ? '' : 's'}</Button>
              <Button variant="secondary" onClick={reset}>Discard preview</Button>
            </div>
            {preview.summary.errors > 0 && <div>Rows with errors are skipped; the rest are applied.</div>}
          </div>
        </Card>
      )}
      <Card>
        <h2 className="kiu-h2">Recent imports</h2>
        {jobs.loading && !jobs.data ? <Skeleton h={80} /> : (
          <>
            <DataTable testId="import-jobs" rows={jobs.data?.data ?? []} empty="No imports yet." columns={[
              { key: 'when', header: 'When', render: (j) => fmt(j.startedAt) },
              { key: 'kind', header: 'Dataset', render: (j) => j.kind },
              { key: 'status', header: 'Status', render: (j) => <StatusChip tone={j.status === 'COMPLETED' ? 'grant' : 'warn'}>{j.status.replace(/_/g, ' ')}</StatusChip> },
              { key: 'rows', header: 'Rows', render: (j) => `${j.rowsOk} ok / ${j.rowsFailed} failed of ${j.rowsTotal}` },
            ]} />
            {jobs.data && <Pager page={jobs.data.meta.page} totalPages={jobs.data.meta.totalPages} total={jobs.data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {confirm && preview && <ReasonModal title="Apply import" intro={`Apply ${preview.summary.ok} change(s) to ${spec.label.toLowerCase()}? Each change is audited and takes effect on the next scan.`} confirmLabel="Apply changes"
        onClose={() => setConfirm(false)} onConfirm={commit} />}
    </div>
  );
}
