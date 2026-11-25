import { Banner, BarChart, Button, Card, DataTable, Skeleton } from '@kiu/ui';
import { useState } from 'react';
import { api, download } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { qs, useApi } from '../lib/hooks';
import { PageHeader, errText } from '../components/Common';

interface Split { grants: number; denies: number }
interface Report {
  from: string; to: string; generatedAt: string;
  totals: { decisions: number; grants: number; denies: number };
  byDay: (Split & { date: string })[];
  byService: (Split & { code: string; name: string })[];
  byReader: (Split & { name: string })[];
  topDenialReasons: { reason: string; count: number }[];
  byMethod: { method: string; count: number }[];
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const pct = (n: number, t: number) => (t ? `${Math.round((n / t) * 100)}%` : '—');

interface Catalog { id: string; label: string; ranged: boolean; canExport: boolean }
interface Domain { title: string; columns: { key: string; label: string }[]; rows: Record<string, string | number | null>[]; summary: Record<string, string | number | null>; truncated: boolean }
const humanise = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** Reports for one office's own data: the list only contains what this person's permissions allow. */
function DomainReports() {
  const cat = useApi<Catalog[]>('/reports/catalog');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(ymd(new Date()));
  const [data, setData] = useState<Domain | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = cat.data?.find((c) => c.id === (kind || cat.data?.[0]?.id));
  if (!cat.data?.length) return null;
  const params = cur?.ranged ? { from, to } : {};
  const run = async () => {
    setBusy(true); setErr(null); setData(null);
    try { setData(await api<Domain>('GET', `/reports/domain/${cur!.id}${qs(params)}`)); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const exportCsv = async () => {
    setBusy(true); setErr(null);
    try { await download(`/reports/domain/${cur!.id}${qs({ ...params, format: 'csv' })}`, `${cur!.id}.csv`); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <Card className="kiu-stack" data-testid="domain-reports">
      <h2>Office reports</h2>
      <div className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div className="kiu-field" style={{ flex: '1 1 220px' }}><label htmlFor="dr-kind">Report</label>
          <select id="dr-kind" className="kiu-input" value={cur?.id ?? ''} onChange={(e) => { setKind(e.target.value); setData(null); }}>{cat.data.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </div>
        {cur?.ranged && <>
          <div className="kiu-field"><label htmlFor="dr-from">From</label><input id="dr-from" className="kiu-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="kiu-field"><label htmlFor="dr-to">To</label><input id="dr-to" className="kiu-input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        </>}
        <Button onClick={run} disabled={busy} data-testid="domain-run">{busy ? 'Working…' : 'Run'}</Button>
        {cur?.canExport && <Button variant="secondary" onClick={exportCsv} disabled={busy} data-testid="domain-export">Download CSV</Button>}
      </div>
      {err && <Banner tone="deny">{err}</Banner>}
      {data && (
        <div className="kiu-stack" data-testid="domain-result">
          <div className="kiu-row" style={{ flexWrap: 'wrap', gap: 16 }}>{Object.entries(data.summary).map(([k, v]) => <span key={k}><strong>{String(v)}</strong> <span className="muted">{humanise(k)}</span></span>)}</div>
          <DataTable rows={data.rows.map((r, i) => ({ ...r, id: String(i) }))} empty="Nothing to report for this selection." columns={data.columns.map((c) => ({ key: c.key, header: c.label, render: (r: Record<string, string | number | null>) => String(r[c.key] ?? '') }))} />
          {data.truncated && <p className="muted">Showing the first rows only; export or narrow the selection.</p>}
        </div>
      )}
    </Card>
  );
}

export function Reports({ me }: { me: Me }) {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(ymd(new Date()));
  const [applied, setApplied] = useState({ from, to });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = useApi<Report>(`/reports/access${qs(applied)}`);
  const canExport = can(me, 'reports.export') && can(me, 'access.logs.view');

  const run = () => { setErr(null); setApplied({ from, to }); };
  const exportCsv = async () => {
    setBusy(true); setErr(null);
    try { await download(`/reports/access/export${qs(applied)}`, `access-${applied.from}_${applied.to}.csv`); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const d = r.data;

  return (
    <div className="kiu-stack">
      <PageHeader title="Reports" />
      <Card>
        <div className="kiu-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <div className="kiu-field"><label htmlFor="rep-from">From</label><input id="rep-from" className="kiu-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="kiu-field"><label htmlFor="rep-to">To</label><input id="rep-to" className="kiu-input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
          <Button onClick={run} disabled={!from || !to} data-testid="report-run">Run report</Button>
          {canExport && <Button variant="secondary" onClick={exportCsv} disabled={busy} data-testid="report-export">{busy ? 'Preparing…' : 'Download CSV'}</Button>}
        </div>
        <p className="muted">Up to 93 days. The CSV lists each decision with registration numbers (up to 10,000 rows) and every download is audited.</p>
      </Card>
      <DomainReports />
      {(err || r.error) && <Banner tone="deny">{err ?? 'The report could not be loaded. Check the dates (at most 93 days) and try again.'}</Banner>}
      {r.loading && !d ? <Skeleton h={160} /> : d && (
        <>
          <div className="kiu-grid cols-3" data-testid="report-totals">
            <Card><div className="muted">Decisions</div><strong style={{ fontSize: 28 }}>{d.totals.decisions}</strong></Card>
            <Card><div className="muted">Granted</div><strong style={{ fontSize: 28 }}>{d.totals.grants}</strong> <span className="muted">{pct(d.totals.grants, d.totals.decisions)}</span></Card>
            <Card><div className="muted">Denied</div><strong style={{ fontSize: 28 }}>{d.totals.denies}</strong> <span className="muted">{pct(d.totals.denies, d.totals.decisions)}</span></Card>
          </div>
          <Card className="kiu-stack">
            <h2>Decisions per day</h2>
            <BarChart label={`Access decisions per day, ${d.from} to ${d.to}`} data={d.byDay.map((x) => ({ label: x.date.slice(5), a: x.grants, b: x.denies }))} />
          </Card>
          <div className="kiu-grid cols-2">
            <Card className="kiu-stack">
              <h2>By service</h2>
              <DataTable rows={d.byService.map((s) => ({ ...s, id: s.code }))} empty="No activity in this period." columns={[
                { key: 'n', header: 'Service', render: (s) => s.name },
                { key: 'g', header: 'Granted', render: (s) => s.grants },
                { key: 'd', header: 'Denied', render: (s) => s.denies },
              ]} />
            </Card>
            <Card className="kiu-stack">
              <h2>Busiest readers</h2>
              <DataTable rows={d.byReader.map((s) => ({ ...s, id: s.name }))} empty="No reader activity in this period." columns={[
                { key: 'n', header: 'Reader', render: (s) => s.name },
                { key: 'g', header: 'Granted', render: (s) => s.grants },
                { key: 'd', header: 'Denied', render: (s) => s.denies },
              ]} />
            </Card>
          </div>
          <Card className="kiu-stack">
            <h2>Top denial reasons</h2>
            <DataTable rows={d.topDenialReasons.map((x) => ({ ...x, id: x.reason }))} empty="No denials in this period." columns={[
              { key: 'r', header: 'Reason', render: (x) => <span className="mono">{x.reason}</span> },
              { key: 'c', header: 'Count', render: (x) => x.count },
            ]} />
          </Card>
        </>
      )}
    </div>
  );
}
