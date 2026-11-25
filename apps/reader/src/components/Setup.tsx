import { Banner, Button, Card, Field, PasswordField } from '@kiu/ui';
import { useState } from 'react';

export interface SetupValues { baseUrl: string; readerId: string; keyId: string; secret: string }

/** One-time reader onboarding: the credentials come from Admin → Readers (shown once at provisioning). */
export function Setup({ onConnect, error }: { onConnect: (v: SetupValues) => Promise<void>; error: string | null }) {
  const [v, setV] = useState<SetupValues>({ baseUrl: 'http://localhost:4000', readerId: '', keyId: '', secret: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof SetupValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.trim() });
  const valid = /^https?:\/\//.test(v.baseUrl) && /^[0-9a-f-]{36}$/i.test(v.readerId) && v.keyId.length > 3 && v.secret.length >= 32;

  return (
    <main className="kiu-page" style={{ maxWidth: 560 }}>
      <h1>Set up this reader</h1>
      <Card className="kiu-stack">
        <p className="muted">Enter the credentials created in the admin console for this device. The secret is stored as a non-extractable key and cannot be read back.</p>
        <form className="kiu-stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onConnect(v); } finally { setBusy(false); } }}>
          <Field id="baseUrl" label="Server address" value={v.baseUrl} onChange={set('baseUrl')} inputMode="url" autoComplete="off" />
          <Field id="readerId" label="Reader ID" hint="UUID shown in Readers" value={v.readerId} onChange={set('readerId')} autoComplete="off" spellCheck={false} />
          <Field id="keyId" label="Key ID" value={v.keyId} onChange={set('keyId')} autoComplete="off" spellCheck={false} />
          <PasswordField id="secret" label="Secret" value={v.secret} onChange={set('secret')} autoComplete="off" />
          {error && <Banner tone="deny">{error}</Banner>}
          <Button type="submit" block disabled={!valid || busy} data-testid="connect">{busy ? 'Connecting…' : 'Connect and sync'}</Button>
        </form>
      </Card>
    </main>
  );
}
