import { Banner, Button, Card, DataTable, Field, Modal, Pager, PasswordField, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, SEVERITY_TONE, errText } from '../components/Common';

// ───────────────────────── access logs ─────────────────────────
interface Log { id: string; occurredAt: string; decision: 'GRANT' | 'DENY'; reasonCode: string; message: string; authMethod: string; offline: boolean; processingMs: number | null; service: { code: string } | null; reader: { code: string } | null; student: { regNo: string; fullName: string } | null }

export function Logs() {
  const [decision, setDecision] = useState('');
  const [service, setService] = useState('');
  const [regNo, setRegNo] = useState('');
  const [page, setPage] = useState(1);
  const services = useApi<{ code: string; name: string }[]>('/services');
  const { data, error, loading } = useApi<Paged<Log>>(`/logs${qs({ decision: decision || undefined, service: service || undefined, regNo: regNo.trim() || undefined, page, pageSize: 20 })}`, { pollMs: 15_000 });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  return (
    <div className="kiu-stack">
      <PageHeader title="Access logs" />
      <Card><div className="kiu-filters">
        <div className="kiu-field"><label htmlFor="ldec">Result</label><select id="ldec" className="kiu-input" value={decision} onChange={(e) => reset(setDecision)(e.target.value)}><option value="">All</option><option>GRANT</option><option>DENY</option></select></div>
        <div className="kiu-field"><label htmlFor="lsvc">Service</label><select id="lsvc" className="kiu-input" value={service} onChange={(e) => reset(setService)(e.target.value)}><option value="">All</option>{services.data?.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></div>
        <Field id="lreg" label="Registration no." value={regNo} onChange={(e) => reset(setRegNo)(e.target.value)} />
      </div></Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (<>
          <DataTable testId="logs" rows={data?.data ?? []} empty="No access events match." columns={[
            { key: 'occurredAt', header: 'Time', render: (l) => fmt(l.occurredAt) },
            { key: 'decision', header: 'Result', render: (l) => <StatusChip tone={l.decision === 'GRANT' ? 'grant' : 'deny'}>{l.decision}</StatusChip> },
            { key: 'service', header: 'Service', render: (l) => l.service?.code ?? '—' }, { key: 'reader', header: 'Reader', render: (l) => <span className="mono">{l.reader?.code ?? '—'}</span> },
            { key: 'student', header: 'Student', render: (l) => (l.student ? `${l.student.fullName} (${l.student.regNo})` : '—') },
            { key: 'reasonCode', header: 'Reason', render: (l) => <span className="mono" title={l.message}>{l.reasonCode}</span> },
            { key: 'mode', header: 'Mode', render: (l) => `${l.authMethod === 'VIRTUAL_TAP' ? 'Tap' : 'QR'}${l.offline ? ' · offline' : ''}` },
            { key: 'processingMs', header: 'ms', render: (l) => l.processingMs ?? '—' },
          ]} />
          {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
        </>)}
      </Card>
    </div>
  );
}

// ───────────────────────── alerts ─────────────────────────
interface Alert { id: string; kind: string; severity: string; createdAt: string; ackedAt: string | null; reader: { code: string } | null; student: { regNo: string; fullName: string } | null }

export function Alerts({ me }: { me: Me }) {
  const [state, setState] = useState<'open' | 'acknowledged' | 'all'>('open');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [ack, setAck] = useState<Alert | null>(null);
  const { data, error, loading, reload } = useApi<Paged<Alert>>(`/alerts${qs({ state, severity: severity || undefined, page, pageSize: 15 })}`, { pollMs: 10_000 });
  const manage = can(me, 'alerts.manage');
  return (
    <div className="kiu-stack">
      <PageHeader title="Security alerts" />
      <Card><div className="kiu-filters">
        <div className="kiu-field"><label htmlFor="astate">Show</label><select id="astate" className="kiu-input" value={state} onChange={(e) => { setState(e.target.value as typeof state); setPage(1); }}><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="all">All</option></select></div>
        <div className="kiu-field"><label htmlFor="asev">Severity</label><select id="asev" className="kiu-input" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}><option value="">All</option>{['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}</select></div>
      </div></Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (<>
          <DataTable testId="alerts" rows={data?.data ?? []} empty={state === 'open' ? 'No open alerts. 🎉' : 'Nothing here.'} columns={[
            { key: 'createdAt', header: 'Time', render: (a) => fmt(a.createdAt) },
            { key: 'severity', header: 'Severity', render: (a) => <StatusChip tone={SEVERITY_TONE[a.severity] ?? 'info'}>{a.severity}</StatusChip> },
            { key: 'kind', header: 'Alert', render: (a) => <span className="mono">{a.kind}</span> },
            { key: 'student', header: 'Student', render: (a) => (a.student ? `${a.student.fullName} (${a.student.regNo})` : '—') },
            { key: 'reader', header: 'Reader', render: (a) => <span className="mono">{a.reader?.code ?? '—'}</span> },
            { key: 'a', header: 'Status', render: (a) => (a.ackedAt ? <StatusChip tone="info">Acknowledged</StatusChip> : manage ? <Button variant="secondary" onClick={() => setAck(a)} data-testid={`ack-${a.id}`}>Acknowledge</Button> : <StatusChip tone="warn">Open</StatusChip>) },
          ]} />
          {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
        </>)}
      </Card>
      {ack && <ReasonModal title="Acknowledge alert" intro={<>Record what was done about <span className="mono">{ack.kind}</span>.</>} confirmLabel="Acknowledge" onClose={() => setAck(null)}
        onConfirm={async (note) => { await api('POST', `/alerts/${ack.id}/ack`, { note }); reload(); }} />}
    </div>
  );
}

// ───────────────────────── audit ─────────────────────────
interface AuditRow { seq: string; id: string; at: string; actorId: string | null; action: string; entityType: string; entityId: string | null; reason: string | null; hash: string }

export function Audit() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtSeq: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading } = useApi<Paged<AuditRow>>(`/audit${qs({ action: action.trim() || undefined, entityType: entityType.trim() || undefined, page, pageSize: 20 })}`);
  return (
    <div className="kiu-stack">
      <PageHeader title="Audit trail">
        <Button variant="ink" disabled={busy} data-testid="verify-chain" onClick={async () => { setBusy(true); try { setVerify(await api('GET', '/audit/verify')); } finally { setBusy(false); } }}>{busy ? 'Verifying…' : 'Verify integrity'}</Button>
      </PageHeader>
      {verify && <div data-testid="verify-result"><Banner tone={verify.ok ? 'grant' : 'deny'}>{verify.ok ? `Hash chain intact: ${verify.checked} entries verified.` : `TAMPERING DETECTED at entry #${verify.brokenAtSeq} (after ${verify.checked} valid entries).`}</Banner></div>}
      <Card><div className="kiu-filters">
        <Field id="aact" label="Action starts with" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} placeholder="cards." />
        <Field id="aent" label="Entity type" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} placeholder="Card" />
      </div></Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (<>
          <DataTable testId="audit" rows={data?.data ?? []} empty="No entries." columns={[
            { key: 'seq', header: '#' }, { key: 'at', header: 'Time', render: (r) => fmt(r.at) },
            { key: 'action', header: 'Action', render: (r) => <span className="mono">{r.action}</span> }, { key: 'entityType', header: 'Target' },
            { key: 'actorId', header: 'Actor', render: (r) => <span className="mono">{r.actorId?.slice(0, 8) ?? 'system'}</span> },
            { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
          ]} />
          {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
        </>)}
      </Card>
    </div>
  );
}

// ───────────────────────── users ─────────────────────────
interface UserRow { id: string; email: string; displayName: string; userType: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null; roles: string[] }
interface RoleRow { code: string; name: string; description: string | null; permissions: string[] }

export function Users({ me }: { me: Me }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [change, setChange] = useState<{ u: UserRow; status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' } | null>(null);
  const { data, error, loading, reload } = useApi<Paged<UserRow>>(`/users${qs({ q: q.trim() || undefined, userType: 'STAFF', page, pageSize: 15 })}`);
  const manage = can(me, 'users.manage');
  return (
    <div className="kiu-stack">
      <PageHeader title="Staff accounts">{manage && <Button onClick={() => setCreating(true)} data-testid="new-user">Add staff member</Button>}</PageHeader>
      <Card><Field id="uq" label="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (<>
          <DataTable testId="users" rows={data?.data ?? []} empty="No staff accounts." columns={[
            { key: 'displayName', header: 'Name', render: (u) => <>{u.displayName}<br /><span className="muted">{u.email}</span></> },
            { key: 'roles', header: 'Roles', render: (u) => u.roles.join(', ') },
            { key: 'status', header: 'Status', render: (u) => <StatusChip tone={u.status === 'ACTIVE' ? 'grant' : 'deny'}>{u.status}</StatusChip> },
            { key: 'mfaEnabled', header: 'MFA', render: (u) => (u.mfaEnabled ? <StatusChip tone="grant">On</StatusChip> : <StatusChip tone="warn">Off</StatusChip>) },
            { key: 'lastLoginAt', header: 'Last sign-in', render: (u) => fmt(u.lastLoginAt) },
            { key: 'a', header: '', render: (u) => manage && u.id !== me.id ? (u.status === 'ACTIVE'
              ? <Button variant="secondary" onClick={() => setChange({ u, status: 'SUSPENDED' })}>Suspend</Button>
              : <Button variant="secondary" onClick={() => setChange({ u, status: 'ACTIVE' })}>Reactivate</Button>) : null },
          ]} />
          {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
        </>)}
      </Card>
      <RolesCard />
      {creating && <NewUser me={me} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {change && <ReasonModal title={`${change.status === 'ACTIVE' ? 'Reactivate' : 'Suspend'} ${change.u.displayName}`} confirmLabel="Confirm" danger={change.status !== 'ACTIVE'}
        intro={change.status !== 'ACTIVE' ? 'Their sessions end immediately.' : undefined} onClose={() => setChange(null)}
        onConfirm={async (reason) => { await api('PATCH', `/users/${change.u.id}`, { status: change.status, reason }); reload(); }} />}
    </div>
  );
}

function RolesCard() {
  const { data } = useApi<RoleRow[]>('/roles');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="kiu-stack">
      <h2>Roles and permissions</h2>
      <DataTable testId="roles" rows={(data ?? []).map((r) => ({ id: r.code, ...r }))} columns={[
        { key: 'name', header: 'Role', render: (r) => <button type="button" className="link-btn" onClick={() => setOpen(open === r.code ? null : r.code)} aria-expanded={open === r.code}>{r.name}</button> },
        { key: 'description', header: 'Purpose', render: (r) => r.description ?? '' },
        { key: 'permissions', header: 'Permissions', render: (r) => (open === r.code ? <span className="mono" style={{ wordBreak: 'break-word' }}>{r.permissions.join(', ')}</span> : `${r.permissions.length} (expand)`) },
      ]} />
    </Card>
  );
}

function NewUser({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const roles = useApi<RoleRow[]>('/roles');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const assignable = (roles.data ?? []).filter((r) => r.code !== 'STUDENT' && (r.code !== 'SUPER_ADMIN' || me.roles.includes('SUPER_ADMIN')));
  return (
    <Modal title="Add staff member" onClose={onClose}>
      <form className="kiu-stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await api('POST', '/users', { email, displayName: name, password: pw, roleCodes: sel }); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); } }}>
        <Field id="ue" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="un" label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <PasswordField id="up" label="Temporary password" hint="12+ characters. They must change it at first sign-in." value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        <fieldset style={{ border: 'var(--border)', borderRadius: 12, padding: 12 }}>
          <legend style={{ fontWeight: 800 }}>Roles</legend>
          {assignable.map((r) => (
            <label key={r.code} className="kiu-row" style={{ minHeight: 44, flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={sel.includes(r.code)} onChange={(e) => setSel(e.target.checked ? [...sel, r.code] : sel.filter((c) => c !== r.code))} style={{ width: 22, height: 22 }} /> <span><strong>{r.name}</strong> <span className="muted">{r.description}</span></span>
            </label>
          ))}
        </fieldset>
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row"><Button type="submit" disabled={!email || !name || pw.length < 12 || sel.length === 0 || busy} data-testid="user-create">{busy ? 'Creating…' : 'Create account'}</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}
