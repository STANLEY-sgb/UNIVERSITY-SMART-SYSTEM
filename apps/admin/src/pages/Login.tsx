import { Banner, Button, Card, Field, PasswordField } from '@kiu/ui';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { SecretModal } from '../components/Common';

/**
 * Staff sign-in. Handles the three real states: password only, password + TOTP/recovery code, and the forced first-time
 * MFA enrolment that privileged roles must finish before anything else is reachable.
 */
export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = await api<{ mfaSetupRequired: boolean; user: { userType: string } }>('POST', '/auth/login', { email, password, ...(needCode ? { mfaCode } : {}) });
      if (r.user.userType !== 'STAFF') { await api('POST', '/auth/logout', {}); throw new ApiError(403, 'NOT_STAFF', 'This console is for staff. Students use the wallet app.'); }
      if (r.mfaSetupRequired) setSetup(await api('POST', '/auth/mfa/setup', {}));
      else onDone();
    } catch (x) {
      if (x instanceof ApiError && x.code === 'MFA_REQUIRED') { setNeedCode(true); setErr(null); }
      else setErr(x instanceof ApiError ? (x.status === 429 ? 'Too many attempts. Wait a minute and try again.' : x.status === 423 ? 'This account is temporarily locked. Try again later or reset your password.' : x.message) : 'Could not reach the server.');
    } finally { setBusy(false); }
  };

  const enable = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { setRecovery((await api<{ recoveryCodes: string[] }>('POST', '/auth/mfa/enable', { code })).recoveryCodes); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not enable MFA.'); } finally { setBusy(false); }
  };

  if (recovery) {
    return (
      <main className="kiu-page" style={{ maxWidth: 520 }}>
        <SecretModal title="Save your recovery codes" note="Each code works once if you lose your authenticator. They are shown only now."
          secrets={[{ label: 'Recovery codes', value: recovery.join('   ') }]} onClose={onDone} />
      </main>
    );
  }

  if (setup) {
    return (
      <main className="kiu-page" style={{ maxWidth: 560 }}>
        <h1>Secure your account</h1>
        <Card className="kiu-stack">
          <Banner tone="warn">Your role requires multi-factor authentication before you can use the console.</Banner>
          <p>Add this key to an authenticator app (Google Authenticator, Authy, 1Password…), then enter the 6-digit code it shows.</p>
          <div className="kiu-code" data-testid="mfa-secret">{setup.secret}</div>
          <p className="kiu-hint mono" style={{ wordBreak: 'break-all' }}>{setup.otpauthUrl}</p>
          <form className="kiu-stack" onSubmit={enable}>
            <Field id="mfa-enable" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} error={err} />
            <Button type="submit" disabled={code.length !== 6 || busy} data-testid="mfa-enable">{busy ? 'Checking…' : 'Turn on MFA'}</Button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="kiu-page" style={{ maxWidth: 480 }}>
      <h1>KIU Admin</h1>
      <Card className="kiu-stack">
        <form className="kiu-stack" onSubmit={submit}>
          <Field id="email" label="Staff email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField id="password" label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {needCode && <Field id="mfa" label="Authenticator or recovery code" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} hint="6 digits, or one of your recovery codes" />}
          {err && <Banner tone="deny">{err}</Banner>}
          <Button type="submit" block disabled={!email || !password || (needCode && !mfaCode) || busy} data-testid="login">{busy ? 'Signing in…' : needCode ? 'Verify and sign in' : 'Sign in'}</Button>
        </form>
        <p className="kiu-hint">Prototype with fictional data. Not an official KIU system.</p>
      </Card>
    </main>
  );
}
