import { Banner, Button, Card, DataTable, Field, Pager, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, SecretModal, errText } from '../components/Common';

interface CardRow { id: string; cardNumber: string; status: string; issuedAt: string | null; expiresAt: string; activatedAt: string | null; student: { regNo: string; fullName: string } }
type Action = { kind: 'block' | 'unblock' | 'lost' | 'replace' | 'reset'; card: CardRow };

const TONE: Record<string, 'grant' | 'deny' | 'warn' | 'info'> = { ACTIVE: 'grant', PENDING: 'warn', BLOCKED: 'deny', LOST: 'deny', EXPIRED: 'info' };

export function Cards({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const [secret, setSecret] = useState<{ title: string; items: { label: string; value: string }[] } | null>(null);
  const [issueReg, setIssueReg] = useState('');
  const [issueErr, setIssueErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useApi<Paged<CardRow>>(`/cards${qs({ q: q.trim() || undefined, status: status || undefined, page, pageSize: 15 })}`);

  const run = async (a: Action, reason: string) => {
    const id = a.card.id;
    if (a.kind === 'block') await api('POST', `/cards/${id}/block`, { reason });
    else if (a.kind === 'unblock') await api('POST', `/cards/${id}/unblock`, { reason });
    else if (a.kind === 'lost') await api('POST', `/cards/${id}/report-lost`, { reason });
    else if (a.kind === 'reset') {
      const r = await api<{ activationCode: string }>('POST', `/cards/${id}/reset-activation`, {});
      setSecret({ title: 'New activation code', items: [{ label: 'Activation code', value: r.activationCode }] });
    } else {
      const r = await api<{ card: { cardNumber: string }; activationCode: string }>('POST', `/cards/${id}/replace`, { reason });
      setSecret({ title: 'Replacement issued', items: [{ label: 'Activation code', value: r.activationCode }, { label: 'New card number', value: r.card.cardNumber }] });
    }
    reload();
  };

  const issue = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setIssueErr(null);
    try {
      const r = await api<{ card: { cardNumber: string }; activationCode: string }>('POST', '/cards', { regNo: issueReg.trim() });
      setSecret({ title: 'Card issued', items: [{ label: 'Activation code', value: r.activationCode }, { label: 'Card number', value: r.card.cardNumber }] });
      setIssueReg(''); reload();
    } catch (x) { setIssueErr(errText(x)); } finally { setBusy(false); }
  };

  const canBlock = can(me, 'cards.block'), canReplace = can(me, 'cards.replace'), canIssue = can(me, 'cards.issue');
  const copy: Record<Action['kind'], { title: string; confirm: string; danger?: boolean; intro: (c: CardRow) => string }> = {
    block: { title: 'Block card', confirm: 'Block card', intro: (c) => `Block ${c.cardNumber}? Readers will refuse it until it is unblocked.` },
    unblock: { title: 'Unblock card', confirm: 'Unblock card', intro: (c) => `Restore ${c.cardNumber} for ${c.student.fullName}?` },
    lost: { title: 'Report lost', confirm: 'Disable permanently', danger: true, intro: (c) => `${c.cardNumber} will be disabled everywhere and can never be reactivated. A replacement can be issued afterwards.` },
    replace: { title: 'Replace card', confirm: 'Replace card', intro: (c) => `Retire ${c.cardNumber} as lost and issue a new card with fresh identifiers and keys. The student keeps all entitlements.` },
    reset: { title: 'Re-enrol device', confirm: 'Create new code', intro: (c) => `Create a new activation code for ${c.cardNumber} (new phone). The old device key stops working once the new one is activated.` },
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Cards" />
      {canIssue && (
        <Card>
          <form className="kiu-row" style={{ alignItems: 'flex-end' }} onSubmit={issue}>
            <div style={{ flex: '1 1 240px' }}><Field id="issue-reg" label="Issue a card to registration no." value={issueReg} onChange={(e) => setIssueReg(e.target.value)} placeholder="2026-BCS-0001" error={issueErr} /></div>
            <Button type="submit" disabled={!issueReg.trim() || busy} data-testid="issue-submit">{busy ? 'Issuing…' : 'Issue card'}</Button>
          </form>
        </Card>
      )}
      <Card>
        <div className="kiu-filters">
          <Field id="cq" label="Search card number or name" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <div className="kiu-field"><label htmlFor="cstatus">Status</label>
            <select id="cstatus" className="kiu-input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>{['PENDING', 'ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={160} /> : (
          <>
            <DataTable testId="cards" rows={data?.data ?? []} empty="No cards match." columns={[
              { key: 'cardNumber', header: 'Card', render: (c) => <span className="mono">{c.cardNumber}</span> },
              { key: 'student', header: 'Student', render: (c) => `${c.student.fullName} (${c.student.regNo})` },
              { key: 'status', header: 'Status', render: (c) => <StatusChip tone={TONE[c.status] ?? 'info'}>{c.status}</StatusChip> },
              { key: 'activatedAt', header: 'Activated', render: (c) => fmt(c.activatedAt) },
              { key: 'expiresAt', header: 'Expires', render: (c) => fmt(c.expiresAt) },
              { key: 'actions', header: 'Actions', render: (c) => (
                <div className="kiu-row">
                  {canBlock && c.status === 'ACTIVE' && <Button variant="secondary" onClick={() => setAction({ kind: 'block', card: c })} data-testid={`block-${c.cardNumber}`}>Block</Button>}
                  {canBlock && c.status === 'BLOCKED' && <Button variant="secondary" onClick={() => setAction({ kind: 'unblock', card: c })}>Unblock</Button>}
                  {canBlock && ['ACTIVE', 'BLOCKED', 'PENDING'].includes(c.status) && <Button variant="danger" onClick={() => setAction({ kind: 'lost', card: c })} data-testid={`lost-${c.cardNumber}`}>Report lost</Button>}
                  {canReplace && ['ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED'].includes(c.status) && <Button variant="secondary" onClick={() => setAction({ kind: 'replace', card: c })} data-testid={`replace-${c.cardNumber}`}>Replace</Button>}
                  {canIssue && ['ACTIVE', 'PENDING'].includes(c.status) && <Button variant="secondary" onClick={() => setAction({ kind: 'reset', card: c })}>New phone</Button>}
                </div>
              ) },
            ]} />
            {data && <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>

      {action && <ReasonModal title={copy[action.kind].title} intro={copy[action.kind].intro(action.card)} confirmLabel={copy[action.kind].confirm} danger={copy[action.kind].danger}
        onClose={() => setAction(null)} onConfirm={(reason) => run(action, reason)} />}
      {secret && <SecretModal title={secret.title} secrets={secret.items} note="Shown only once. Give the activation code to the student; it expires in 72 hours." onClose={() => setSecret(null)} />}
    </div>
  );
}
