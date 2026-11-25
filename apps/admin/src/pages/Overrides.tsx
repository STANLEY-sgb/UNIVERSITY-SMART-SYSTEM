import { Banner, Button, Card, DataTable, Field, Pager, Skeleton, TextArea } from '@kiu/ui';
import { SERVICE_CODES } from '@kiu/shared';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, errText } from '../components/Common';

interface Row { id: string; at: string; regNo: string; fullName: string; service: string; originalReason: string; reason: string; by: string }

export function Overrides({ me }: { me: Me }) {
  const [page, setPage] = useState(1);
  const canList = can(me, 'access.logs.view');
  const list = useApi<Paged<Row>>(canList ? `/access/overrides${qs({ page, pageSize: 10 })}` : null);
  const [f, setF] = useState({ regNo: '', serviceCode: 'GATE', readerCode: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setOk(null);
    try {
      const r = await api<{ originalReason: string }>('POST', '/access/overrides', { regNo: f.regNo.trim(), serviceCode: f.serviceCode, ...(f.readerCode.trim() ? { readerCode: f.readerCode.trim() } : {}), reason: f.reason.trim() });
      setOk(`Override recorded for ${f.regNo.trim()} (refused for ${r.originalReason}). Let the student through now; the refusal itself is unchanged.`);
      setF({ ...f, regNo: '', reason: '' }); list.reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Manual overrides" />
      <Banner tone="warn">An override lets one student through after a genuine rule refusal in the last 30 minutes. It cannot cover a lost or blocked card, a suspended account, a failed credential or a face check. Every override is logged, audited and raises an alert for review.</Banner>
      <Card>
        <form className="kiu-stack" onSubmit={submit}>
          <div className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 160px' }}><Field id="ov-reg" label="Registration number" value={f.regNo} onChange={(e) => setF({ ...f, regNo: e.target.value })} autoComplete="off" /></div>
            <div className="kiu-field" style={{ flex: '1 1 160px' }}><label htmlFor="ov-svc">Service</label>
              <select id="ov-svc" className="kiu-input" value={f.serviceCode} onChange={(e) => setF({ ...f, serviceCode: e.target.value })}>{SERVICE_CODES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select>
            </div>
            <div style={{ flex: '1 1 160px' }}><Field id="ov-reader" label="Reader code (optional)" value={f.readerCode} onChange={(e) => setF({ ...f, readerCode: e.target.value })} /></div>
          </div>
          <TextArea id="ov-reason" label="Why is this justified? (at least 10 characters, kept in the audit trail)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <div className="kiu-row"><Button type="submit" disabled={busy || !f.regNo.trim() || f.reason.trim().length < 10} data-testid="override-submit">{busy ? 'Recording…' : 'Record override'}</Button></div>
        </form>
      </Card>
      {err && <Banner tone="deny">{err}</Banner>}
      {ok && <Banner tone="grant">{ok}</Banner>}
      {canList && (
        <Card>
          <h2>Recent overrides</h2>
          {list.loading && !list.data ? <Skeleton h={100} /> : (
            <>
              <DataTable testId="overrides" rows={list.data?.data ?? []} empty="No overrides recorded." columns={[
                { key: 'at', header: 'When', render: (r) => fmt(r.at) },
                { key: 'who', header: 'Student', render: (r) => <span>{r.fullName} <span className="mono muted">{r.regNo}</span></span> },
                { key: 'svc', header: 'Service', render: (r) => r.service },
                { key: 'orig', header: 'Refused for', render: (r) => <span className="mono">{r.originalReason}</span> },
                { key: 'by', header: 'By', render: (r) => r.by },
                { key: 'why', header: 'Reason', render: (r) => r.reason },
              ]} />
              {list.data && <Pager page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={setPage} />}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
