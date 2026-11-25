import { CheckCircle2, Clock, Eye, EyeOff, Info, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({ children, accent, interactive, flat, className, ...rest }: { children: ReactNode; accent?: 'pink' | 'purple' | 'green' | 'yellow' | 'aqua'; interactive?: boolean; flat?: boolean; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return <section {...rest} className={cx('kiu-card', accent && `accent-${accent}`, interactive && 'interactive', flat && 'flat', className)}>{children}</section>;
}

export function IconTile({ children }: { children: ReactNode }) {
  return <span className="kiu-tile" aria-hidden="true">{children}</span>;
}

export function Button({ variant, block, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'secondary' | 'ink' | 'danger'; block?: boolean }) {
  return <button type="button" {...rest} className={cx('kiu-btn', variant, block && 'block', className)} />;
}

export type Tone = 'grant' | 'deny' | 'warn' | 'info';
const TONE_ICON: Record<Tone, ReactNode> = {
  grant: <CheckCircle2 size={16} aria-hidden />, deny: <XCircle size={16} aria-hidden />, warn: <Clock size={16} aria-hidden />, info: <Info size={16} aria-hidden />,
};
/** Status is always icon + words, never colour alone. */
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cx('kiu-chip', tone)}>{TONE_ICON[tone]}{children}</span>;
}

export function Banner({ tone = 'info', children, role }: { tone?: Tone; children: ReactNode; role?: 'status' | 'alert' }) {
  return <div className={cx('kiu-banner', tone)} role={role ?? (tone === 'deny' ? 'alert' : 'status')}>{tone === 'deny' ? <ShieldAlert size={20} aria-hidden /> : TONE_ICON[tone]}<div>{children}</div></div>;
}

export function Field({ label, hint, error, id, ...rest }: { label: string; hint?: string; error?: string | null; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="kiu-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="kiu-input" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} {...rest} />
      {hint && !error && <span id={`${id}-hint`} className="kiu-hint">{hint}</span>}
      {error && <span id={`${id}-err`} className="kiu-error-text" role="alert">{error}</span>}
    </div>
  );
}

/** Same as Field, but masked with a show/hide toggle so a typed password can be checked before submitting. */
export function PasswordField({ label, hint, error, id, ...rest }: { label: string; hint?: string; error?: string | null; id: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="kiu-field">
      <label htmlFor={id}>{label}</label>
      <div className="kiu-input-group">
        <input
          id={id} type={visible ? 'text' : 'password'} className="kiu-input"
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
          {...rest}
        />
        <button
          type="button" className="kiu-input-toggle" onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}
        >
          {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
      {hint && !error && <span id={`${id}-hint`} className="kiu-hint">{hint}</span>}
      {error && <span id={`${id}-err`} className="kiu-error-text" role="alert">{error}</span>}
    </div>
  );
}

export function TextArea({ label, id, ...rest }: { label: string; id: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <div className="kiu-field"><label htmlFor={id}>{label}</label><textarea id={id} className="kiu-input" {...rest} /></div>;
}

export interface SegmentOption<T extends string> { value: T; label: string; disabled?: boolean; title?: string }
/** Radio-group semantics for the SCAN QR | VIRTUAL TAP | SCAN FACE selector. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="kiu-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** 30-second countdown ring. */
export function CountdownRing({ seconds, total, size = 64 }: { seconds: number; total: number; size?: number }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, seconds / total));
  const low = seconds <= 5;
  return (
    <span className="kiu-ring" role="timer" aria-label={`${Math.max(0, Math.ceil(seconds))} seconds until the code refreshes`} style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ddd" strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={low ? 'var(--deny)' : 'var(--ink)'} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: 'stroke-dashoffset 1s linear' }} />
      </svg>
      <span className="num">{Math.max(0, Math.ceil(seconds))}</span>
    </span>
  );
}

export function Skeleton({ h = 18, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="kiu-skel" style={{ height: h, width: w }} aria-hidden />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <Card flat style={{ textAlign: 'center' }}><h3>{title}</h3>{children && <p className="muted">{children}</p>}</Card>;
}

/** Full-width GRANT/DENY verdict with reason and an animated virtual door (opens 3 s on GRANT, stays locked on DENY). */
export function ResultPanel({ decision, reason, message, name, sub, doorOpen, offline }: {
  decision: 'GRANT' | 'DENY'; reason: string; message: string; name?: string | null; sub?: string | null; doorOpen: boolean; offline?: boolean;
}) {
  const grant = decision === 'GRANT';
  return (
    <div className={cx('kiu-result kiu-pop', grant ? 'grant' : 'deny')} role="alert" aria-live="assertive" data-testid="result" data-decision={decision} data-reason={reason}>
      <div className="verdict">{grant ? '✓ GRANT' : '✕ DENY'}</div>
      {name && <div style={{ fontWeight: 800, fontSize: '1.3rem' }} data-testid="result-name">{name}</div>}
      {sub && <div className="muted">{sub}</div>}
      <div className="reason" data-testid="result-message">{message}</div>
      <div className="kiu-row" style={{ justifyContent: 'center' }}>
        <StatusChip tone={grant ? 'grant' : 'deny'}>{grant ? 'Access granted' : 'Access denied'}</StatusChip>
        {offline && <StatusChip tone="warn">Decided offline</StatusChip>}
        <span className="mono muted">{reason}</span>
      </div>
      <div className="kiu-door" data-open={doorOpen} data-state={grant ? 'grant' : 'deny'} role="img" aria-label={doorOpen ? 'Door open' : 'Door locked'}>
        <span className="lbl" aria-hidden>{doorOpen ? 'DOOR OPEN' : 'LOCKED'}</span>
      </div>
    </div>
  );
}

export interface NavItem { to: string; label: string; icon: ReactNode }
export function Nav({ items, current, onNavigate, trailing }: { items: NavItem[]; current: string; onNavigate: (to: string) => void; trailing?: ReactNode }) {
  return (
    <nav className="kiu-nav" aria-label="Primary">
      {items.map((i) => (
        <a key={i.to} href={`#${i.to}`} aria-current={current === i.to ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onNavigate(i.to); }}>
          {i.icon}<span>{i.label}</span>
        </a>
      ))}
      {trailing}
    </nav>
  );
}
