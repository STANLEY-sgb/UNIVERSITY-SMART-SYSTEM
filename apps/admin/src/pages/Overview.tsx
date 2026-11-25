import { Banner, BarChart, Card, DataTable, Skeleton, StatusChip } from '@kiu/ui';
import { useApi, useLiveEvents, fmt } from '../lib/hooks';
import { PageHeader, SEVERITY_TONE } from '../components/Common';

interface Summary {
  generatedAt: string;
  students: { active: number };
  cards: Record<string, number>;
  readers: { total: number; active: number; online: number; revoked: number };
  today: { grants: number; denies: number; offline: number; examAttendance: number };
  topDenialReasons: { reason: string; count: number }[];
  byService: { code: string; name: string; grants: number; denies: number }[];
  hourly: { hour: string; decision: 'GRANT' | 'DENY'; count: number }[];
  openAlerts: Record<string, number>;
  recentDecisions?: { id: string; occurredAt: string; decision: 'GRANT' | 'DENY'; reasonCode: string; offline: boolean; service: { name: string } | null; reader: { code: string } | null; student: { regNo: string; fullName: string } | null }[];
  recentAdminActions?: { id: string; at: string; action: string; entityType: string; actor: string | null; reason: string | null }[];
}

function Stat({ label, value, id }: { label: string; value: number | string; id: string }) {
  return <Card className="kiu-stat" data-testid={`stat-${id}`}><span className="n">{value}</span><span className="l">{label}</span></Card>;
}

export function Overview() {
  const { data: s, error, reload } = useApi<Summary>('/dashboard/summary', { pollMs: 30_000 });
  const live = useLiveEvents(reload);
  if (error) return <Banner tone="deny">{error}</Banner>;
  if (!s) return <div className="kiu-grid cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Card key={i}><Skeleton h={36} w="40%" /><div style={{ height: 8 }} /><Skeleton /></Card>)}</div>;

  const hours = new Map<string, { a: number; b: number }>();
  for (const h of s.hourly) {
    const k = new Date(h.hour).getHours().toString().padStart(2, '0');
    const e = hours.get(k) ?? { a: 0, b: 0 };
    if (h.decision === 'GRANT') e.a += h.count; else e.b += h.count;
    hours.set(k, e);
  }
  const chart = [...hours.entries()].map(([label, v]) => ({ label, ...v }));
  const alerts = Object.entries(s.openAlerts);

  return (
    <div className="kiu-stack">
      <PageHeader title="Overview"><span className="muted" data-testid="live-state" data-live={live} aria-live="polite">{live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'} · updated {new Date(s.generatedAt).toLocaleTimeString()}</span></PageHeader>

      <div className="kiu-grid cols-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Stat id="students" label="Active students" value={s.students.active} />
        <Stat id="cards-active" label="Active cards" value={s.cards.ACTIVE ?? 0} />
        <Stat id="cards-blocked" label="Blocked / lost cards" value={(s.cards.BLOCKED ?? 0) + (s.cards.LOST ?? 0)} />
        <Stat id="readers" label="Readers online" value={`${s.readers.online} / ${s.readers.active}`} />
        <Stat id="grants" label="Granted today" value={s.today.grants} />
        <Stat id="denies" label="Denied today" value={s.today.denies} />
        <Stat id="exam" label="Exam attendance today" value={s.today.examAttendance} />
        <Stat id="offline" label="Decided offline today" value={s.today.offline} />
      </div>

      {alerts.length > 0 && (
        <Banner tone="warn">
          <strong>Open security alerts:</strong>{' '}
          {alerts.map(([sev, n]) => <span key={sev} style={{ marginRight: 8 }}><StatusChip tone={SEVERITY_TONE[sev] ?? 'info'}>{sev} {n}</StatusChip></span>)}
          <a href="#/alerts">Review</a>
        </Banner>
      )}

      <div className="kiu-grid cols-2">
        <Card className="kiu-stack">
          <h2>Traffic today (by hour)</h2>
          {chart.length === 0 ? <p className="muted">No decisions yet today.</p> : <BarChart label="Access decisions per hour today" data={chart} />}
        </Card>
        <Card className="kiu-stack">
          <h2>Top denial reasons</h2>
          <DataTable testId="reasons" rows={s.topDenialReasons.map((r) => ({ id: r.reason, ...r }))} empty="No denials today." columns={[
            { key: 'reason', header: 'Reason', render: (r) => <span className="mono">{r.reason}</span> }, { key: 'count', header: 'Count' },
          ]} />
        </Card>
      </div>

      <Card className="kiu-stack">
        <h2>By service today</h2>
        <DataTable testId="by-service" rows={s.byService.map((r) => ({ id: r.code, ...r }))} empty="No activity yet today." columns={[
          { key: 'name', header: 'Service' }, { key: 'grants', header: 'Granted' }, { key: 'denies', header: 'Denied' },
        ]} />
      </Card>

      {s.recentDecisions && (
        <Card className="kiu-stack">
          <h2>Recent decisions</h2>
          <DataTable testId="recent-decisions" rows={s.recentDecisions} empty="No decisions yet." columns={[
            { key: 'occurredAt', header: 'Time', render: (r) => fmt(r.occurredAt) },
            { key: 'decision', header: 'Result', render: (r) => <StatusChip tone={r.decision === 'GRANT' ? 'grant' : 'deny'}>{r.decision}</StatusChip> },
            { key: 'service', header: 'Service', render: (r) => r.service?.name ?? '—' },
            { key: 'student', header: 'Student', render: (r) => (r.student ? `${r.student.fullName} (${r.student.regNo})` : '—') },
            { key: 'reasonCode', header: 'Reason', render: (r) => <span className="mono">{r.reasonCode}{r.offline ? ' · offline' : ''}</span> },
          ]} />
        </Card>
      )}

      {s.recentAdminActions && (
        <Card className="kiu-stack">
          <h2>Recent administrative actions</h2>
          <DataTable testId="recent-actions" rows={s.recentAdminActions} columns={[
            { key: 'at', header: 'Time', render: (r) => fmt(r.at) }, { key: 'action', header: 'Action', render: (r) => <span className="mono">{r.action}</span> },
            { key: 'entityType', header: 'Target' }, { key: 'actor', header: 'By', render: (r) => r.actor ?? 'system' },
          ]} />
        </Card>
      )}
    </div>
  );
}
