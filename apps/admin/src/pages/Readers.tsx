import { Banner, Button, Card, DataTable, Field, Modal, Skeleton, StatusChip } from '@kiu/ui';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, SecretModal, errText } from '../components/Common';

interface Reader { id: string; code: string; name: string; status: string; supportsFace: boolean; lastHeartbeatAt: string | null; service: { code: string; name: string }; venue: { code: string; name: string } }
const ONLINE_MS = 2 * 60_000;
const isOnline = (r: Reader) => r.status === 'ACTIVE' && !!r.lastHeartbeatAt && Date.now() - Date.parse(r.lastHeartbeatAt) < ONLINE_MS;

export function Readers({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<Paged<Reader>>('/readers?pageSize=100', { pollMs: 15_000 });
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<{ reader: Reader; to: 'ACTIVE' | 'DISABLED' | 'REVOKED' } | null>(null);
  const [secret, setSecret] = useState<{ title: string; items: { label: string; value: string }[] } | null>(null);
  const manage = can(me, 'readers.manage');

  const rotate = async (r: Reader) => {
    const res = await api<{ credentials: { keyId: string; secret: string } }>('POST', `/readers/${r.id}/rotate-credential`, {});
    setSecret({ title: `New credentials for ${r.code}`, items: [{ label: 'Key ID', value: res.credentials.keyId }, { label: 'Secret', value: res.credentials.secret }] });
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Readers">{manage && <Button onClick={() => setCreating(true)} data-testid="new-reader">Provision reader</Button>}</PageHeader>
      {error && <Banner tone="deny">{error}</Banner>}
      <Card>
        {loading && !data ? <Skeleton h={140} /> : (
          <DataTable testId="readers" rows={data?.data ?? []} empty="No readers provisioned yet." columns={[
            { key: 'code', header: 'Reader', render: (r) => <><span className="mono">{r.code}</span><br /><span className="muted">{r.name}</span></> },
            { key: 'service', header: 'Service', render: (r) => r.service.name },
            { key: 'venue', header: 'Venue', render: (r) => r.venue.name },
            { key: 'status', header: 'Status', render: (r) => <StatusChip tone={r.status === 'ACTIVE' ? 'grant' : r.status === 'REVOKED' ? 'deny' : 'warn'}>{r.status}</StatusChip> },
            { key: 'online', header: 'Connection', render: (r) => (isOnline(r) ? <StatusChip tone="grant">Online</StatusChip> : <StatusChip tone="warn">Offline</StatusChip>) },
            { key: 'lastHeartbeatAt', header: 'Last heartbeat', render: (r) => fmt(r.lastHeartbeatAt) },
            { key: 'actions', header: 'Actions', render: (r) => manage && r.status !== 'REVOKED' ? (
              <div className="kiu-row">
                <Button variant="secondary" onClick={() => void rotate(r)} data-testid={`rotate-${r.code}`}>Rotate key</Button>
                {r.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => setStatus({ reader: r, to: 'DISABLED' })}>Disable</Button> : <Button variant="secondary" onClick={() => setStatus({ reader: r, to: 'ACTIVE' })}>Enable</Button>}
                <Button variant="danger" onClick={() => setStatus({ reader: r, to: 'REVOKED' })} data-testid={`revoke-${r.code}`}>Revoke</Button>
              </div>
            ) : <span className="muted">{r.status === 'REVOKED' ? 'Permanently revoked' : '—'}</span> },
          ]} />
        )}
      </Card>
      {creating && <NewReader onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setSecret({ title: `Reader ${r.code} created`, items: [{ label: 'Reader ID', value: r.id }, { label: 'Key ID', value: r.keyId }, { label: 'Secret', value: r.secret }] }); reload(); }} />}
      {status && <ReasonModal title={`${status.to === 'REVOKED' ? 'Revoke' : status.to === 'DISABLED' ? 'Disable' : 'Enable'} ${status.reader.code}`} confirmLabel={status.to === 'REVOKED' ? 'Revoke permanently' : 'Confirm'} danger={status.to === 'REVOKED'}
        intro={status.to === 'REVOKED' ? 'A revoked reader and its credentials are refused immediately and cannot be restored.' : undefined}
        onClose={() => setStatus(null)} onConfirm={async (reason) => { await api('PATCH', `/readers/${status.reader.id}/status`, { status: status.to, reason }); reload(); }} />}
      {secret && <SecretModal title={secret.title} secrets={secret.items} note="The secret is shown only once and stored encrypted. Enter these values on the reader device." onClose={() => { setSecret(null); reload(); }} />}
    </div>
  );
}

function NewReader({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { id: string; code: string; keyId: string; secret: string }) => void }) {
  const services = useApi<{ code: string; name: string }[]>('/services');
  const venues = useApi<{ code: string; name: string }[]>('/venues');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  const [venueCode, setVenueCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code) && name.trim().length >= 2 && serviceCode && venueCode;
  return (
    <Modal title="Provision reader" onClose={onClose}>
      <form className="kiu-stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { const r = await api<{ reader: { id: string; code: string }; credentials: { keyId: string; secret: string } }>('POST', '/readers', { code, name: name.trim(), serviceCode, venueCode }); onCreated({ id: r.reader.id, code: r.reader.code, ...r.credentials }); }
        catch (x) { setErr(errText(x)); setBusy(false); }
      }}>
        <Field id="rcode" label="Reader code" hint="Capital letters, digits and dashes, e.g. RDR-GATE-02" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Field id="rname" label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="kiu-field"><label htmlFor="rservice">Service</label>
          <select id="rservice" className="kiu-input" value={serviceCode} onChange={(e) => setServiceCode(e.target.value)}><option value="">Choose…</option>{services.data?.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></div>
        <div className="kiu-field"><label htmlFor="rvenue">Venue</label>
          <select id="rvenue" className="kiu-input" value={venueCode} onChange={(e) => setVenueCode(e.target.value)}><option value="">Choose…</option>{venues.data?.map((v) => <option key={v.code} value={v.code}>{v.name}</option>)}</select></div>
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row"><Button type="submit" disabled={!valid || busy} data-testid="reader-create">{busy ? 'Creating…' : 'Create reader'}</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}
