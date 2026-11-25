import { Banner, Button, Card, DataTable, Field, Skeleton, StatusChip, TextArea } from '@kiu/ui';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, useApi } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';

interface Svc { code: string; name: string; offlinePolicy: string; publishedVersion: number | null; hasDraft: boolean; readers: number }
interface Version { id: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; definition: unknown; changeNote: string | null; publishedAt: string | null; createdAt: string }
interface RuleView { service: { code: string; name: string }; published: Version | null; draft: Version | null }
interface HistoryRow { id: string; version: number; status: string; changeNote: string | null; publishedAt: string | null; createdAt: string }
interface TestResult { regNo: string; allowed: boolean; failure: { reason: string; message: string; fact?: string } | null; trace: { fact: string; op: string; passed: boolean; actual: unknown }[] }

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export function Rules({ me }: { me: Me }) {
  const services = useApi<Svc[]>('/services');
  const [code, setCode] = useState<string | null>(null);
  return (
    <div className="kiu-stack">
      <PageHeader title="Eligibility rules" />
      <Banner tone="info">Rules are validated data, never executed code. Policy thresholds shown as <span className="mono">ctx.policy.*</span> are placeholders awaiting KIU confirmation. Every change is versioned and audited.</Banner>
      <Card>
        {services.loading && !services.data ? <Skeleton h={140} /> : (
          <DataTable testId="rule-services" rows={(services.data ?? []).map((s) => ({ id: s.code, ...s }))} onRowClick={(s) => setCode(s.code)} columns={[
            { key: 'name', header: 'Service', render: (s) => <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setCode(s.code); }} data-testid={`edit-${s.code}`}>{s.name}</button> },
            { key: 'publishedVersion', header: 'Published', render: (s) => (s.publishedVersion ? `v${s.publishedVersion}` : <StatusChip tone="warn">none</StatusChip>) },
            { key: 'hasDraft', header: 'Draft', render: (s) => (s.hasDraft ? <StatusChip tone="info">draft</StatusChip> : '—') },
            { key: 'offlinePolicy', header: 'Offline', render: (s) => <span className="mono">{s.offlinePolicy}</span> },
            { key: 'readers', header: 'Readers' },
          ]} />
        )}
      </Card>
      {code && <Editor key={code} code={code} me={me} onChanged={services.reload} onClose={() => setCode(null)} />}
    </div>
  );
}

function Editor({ code, me, onChanged, onClose }: { code: string; me: Me; onChanged: () => void; onClose: () => void }) {
  const view = useApi<RuleView>(`/services/${code}/rule`);
  const hist = useApi<HistoryRow[]>(`/services/${code}/rule/history`);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [reg, setReg] = useState('');
  const [errs, setErrs] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [rollback, setRollback] = useState<HistoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can(me, 'rules.manage');

  const current = view.data?.draft ?? view.data?.published ?? null;
  useEffect(() => { if (view.data) setText(pretty((view.data.draft ?? view.data.published)?.definition ?? { schemaVersion: 1, requirements: { all: [] } })); }, [view.data]);

  const parse = (): unknown | null => {
    try { return JSON.parse(text); } catch (e) { setErrs([`Not valid JSON: ${(e as Error).message}`]); return null; }
  };
  const fail = (x: unknown) => { setErrs(x instanceof ApiError && Array.isArray(x.details) ? (x.details as string[]) : [errText(x)]); setMsg(null); };
  const after = (m: string) => { setMsg(m); setErrs([]); view.reload(); hist.reload(); onChanged(); };

  const saveDraft = async () => {
    const def = parse(); if (!def) return;
    setBusy(true); setErrs([]);
    try { const r = await api<Version>('PUT', `/services/${code}/rule`, { definition: def, ...(note.trim() ? { changeNote: note.trim() } : {}) }); after(`Draft v${r.version} saved. It does not affect decisions until published.`); }
    catch (x) { fail(x); } finally { setBusy(false); }
  };
  const runTest = async () => {
    const def = parse(); if (!def) return;
    setBusy(true); setErrs([]); setTest(null);
    try { setTest(await api<TestResult>('POST', '/rules/test', { definition: def, regNo: reg.trim() })); } catch (x) { fail(x); } finally { setBusy(false); }
  };
  const publish = async () => {
    if (!view.data?.draft) return;
    setBusy(true); setErrs([]);
    try { await api('POST', `/services/${code}/rule/versions/${view.data.draft.version}/publish`, { ...(note.trim() ? { note: note.trim() } : {}) }); after(`Version ${view.data.draft.version} is now live.`); }
    catch (x) { fail(x); } finally { setBusy(false); }
  };

  return (
    <Card className="kiu-stack" data-testid="rule-editor">
      <div className="kiu-row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{view.data?.service.name ?? code}</h2>
        <div className="kiu-row">
          {view.data?.published && <StatusChip tone="grant">Live: v{view.data.published.version}</StatusChip>}
          {view.data?.draft && <StatusChip tone="info">Draft: v{view.data.draft.version}</StatusChip>}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
      {view.error && <Banner tone="deny">{view.error}</Banner>}
      {view.loading && !view.data ? <Skeleton h={200} /> : (
        <>
          <TextArea id="rule-json" label={`Definition ${current?.status === 'DRAFT' ? '(editing the draft)' : '(copy of the live rule)'}`} value={text} onChange={(e) => setText(e.target.value)} readOnly={!manage} style={{ minHeight: 280, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.85rem' }} spellCheck={false} />
          {errs.length > 0 && <Banner tone="deny"><strong>This rule cannot be saved:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }} data-testid="rule-errors">{errs.map((e) => <li key={e}>{e}</li>)}</ul></Banner>}
          {msg && <Banner tone="grant"><span data-testid="rule-msg">{msg}</span></Banner>}

          <div className="kiu-grid cols-2">
            <Card flat className="kiu-stack">
              <h3>Test against a student</h3>
              <Field id="test-reg" label="Registration number" value={reg} onChange={(e) => setReg(e.target.value)} placeholder="2026-BCS-0001" />
              <Button variant="secondary" onClick={runTest} disabled={!reg.trim() || busy} data-testid="rule-test">Run test</Button>
              <p className="kiu-hint">Uses the student's real current facts. Nothing is written.</p>
              {test && (
                <div className="kiu-stack" data-testid="test-result">
                  <StatusChip tone={test.allowed ? 'grant' : 'deny'}>{test.allowed ? 'Would GRANT' : 'Would DENY'}</StatusChip>
                  {test.failure && <p style={{ margin: 0 }}><strong>{test.failure.reason}</strong>: {test.failure.message}</p>}
                  <DataTable rows={test.trace.map((t, i) => ({ id: String(i), ...t }))} columns={[
                    { key: 'fact', header: 'Fact', render: (t) => <span className="mono">{t.fact}</span> }, { key: 'op', header: 'Test' },
                    { key: 'actual', header: 'Value', render: (t) => String(t.actual ?? 'unknown') }, { key: 'passed', header: 'Result', render: (t) => <StatusChip tone={t.passed ? 'grant' : 'deny'}>{t.passed ? 'pass' : 'fail'}</StatusChip> },
                  ]} />
                </div>
              )}
            </Card>
            {manage && (
              <Card flat className="kiu-stack">
                <h3>Save and publish</h3>
                <Field id="note" label="Change note" value={note} onChange={(e) => setNote(e.target.value)} hint="Shown in the version history and audit trail" />
                <div className="kiu-row">
                  <Button onClick={saveDraft} disabled={busy} data-testid="rule-save">Save as draft</Button>
                  <Button variant="ink" onClick={publish} disabled={busy || !view.data?.draft} data-testid="rule-publish">{view.data?.draft ? `Publish v${view.data.draft.version}` : 'Publish (save a draft first)'}</Button>
                </div>
                <p className="kiu-hint">Publishing makes the rule live for every reader immediately. Test first.</p>
              </Card>
            )}
          </div>

          <h3>Version history</h3>
          <DataTable testId="rule-history" rows={hist.data ?? []} empty="No versions." columns={[
            { key: 'version', header: 'Version', render: (v) => `v${v.version}` },
            { key: 'status', header: 'Status', render: (v) => <StatusChip tone={v.status === 'PUBLISHED' ? 'grant' : v.status === 'DRAFT' ? 'info' : 'warn'}>{v.status}</StatusChip> },
            { key: 'changeNote', header: 'Note', render: (v) => v.changeNote ?? '—' }, { key: 'createdAt', header: 'Created', render: (v) => fmt(v.createdAt) },
            { key: 'a', header: '', render: (v) => manage && v.status === 'ARCHIVED' ? <Button variant="secondary" onClick={() => setRollback(v)} data-testid={`rollback-${v.version}`}>Roll back to this</Button> : null },
          ]} />
        </>
      )}
      {rollback && <ReasonModal title={`Roll back to v${rollback.version}`} intro="This republishes that definition as a new live version. The history stays linear." confirmLabel="Roll back" danger
        onClose={() => setRollback(null)} onConfirm={async (reason) => { await api('POST', `/services/${code}/rule/versions/${rollback.version}/rollback`, { reason }); after(`Rolled back to the definition of v${rollback.version}.`); }} />}
    </Card>
  );
}
