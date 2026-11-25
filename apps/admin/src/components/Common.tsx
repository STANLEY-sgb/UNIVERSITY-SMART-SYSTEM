import { Banner, Button, Modal, TextArea, type Tone } from '@kiu/ui';
import { Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

export const SEVERITY_TONE: Record<string, Tone> = { INFO: 'info', LOW: 'info', MEDIUM: 'warn', HIGH: 'deny', CRITICAL: 'deny' };

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="kiu-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}><h1 style={{ margin: 0 }}>{title}</h1><div className="kiu-row">{children}</div></div>;
}

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Confirmation that records WHY (audited server-side). The action runs only when a reason of 5+ characters is given. */
export function ReasonModal({ title, intro, confirmLabel, danger, minLength = 5, onClose, onConfirm }: {
  title: string; intro?: ReactNode; confirmLabel: string; danger?: boolean; minLength?: number; onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="kiu-stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await onConfirm(reason.trim()); onClose(); } catch (x) { setErr(errText(x)); setBusy(false); } }}>
        {intro && <div>{intro}</div>}
        <TextArea id="reason" label={`Reason (recorded in the audit trail, ${minLength}+ characters)`} value={reason} onChange={(e) => setReason(e.target.value)} />
        {err && <Banner tone="deny">{err}</Banner>}
        <div className="kiu-row">
          <Button type="submit" variant={danger ? 'danger' : undefined} disabled={reason.trim().length < minLength || busy} data-testid="reason-confirm">{busy ? 'Working…' : confirmLabel}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

/** One-time secret display (activation code, reader secret). Never persisted by the console. */
export function SecretModal({ title, secrets, note, onClose }: { title: string; secrets: { label: string; value: string }[]; note: string; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <Banner tone="warn">{note}</Banner>
      {secrets.map((s) => (
        <div key={s.label} className="kiu-stack">
          <strong>{s.label}</strong>
          <div className="kiu-code" data-testid={`secret-${s.label.toLowerCase().replace(/\W+/g, '-')}`}>{s.value}</div>
          <Button variant="secondary" onClick={async () => { await navigator.clipboard?.writeText(s.value).catch(() => undefined); setCopied(s.label); }}><Copy size={16} aria-hidden /> {copied === s.label ? 'Copied' : `Copy ${s.label.toLowerCase()}`}</Button>
        </div>
      ))}
      <Button onClick={onClose} data-testid="secret-done">I have saved it</Button>
    </Modal>
  );
}
