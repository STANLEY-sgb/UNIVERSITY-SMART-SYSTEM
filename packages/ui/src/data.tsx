import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './components';

export interface Column<T> { key: string; header: string; render?: (row: T) => ReactNode; className?: string }

/** Table that becomes stacked cards below 640 px (each cell carries its header as data-label). */
export function DataTable<T extends { id?: string }>({ columns, rows, empty, testId, rowKey, onRowClick }: {
  columns: Column<T>[]; rows: T[]; empty?: ReactNode; testId?: string; rowKey?: (r: T, i: number) => string; onRowClick?: (r: T) => void;
}) {
  if (rows.length === 0) return <div className="kiu-empty" data-testid={testId ? `${testId}-empty` : undefined}>{empty ?? 'Nothing to show.'}</div>;
  return (
    <div className="kiu-tablewrap">
      <table className="kiu-table" data-testid={testId}>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col">{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : (r.id ?? i)} className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}>
              {columns.map((c) => <td key={c.key} data-label={c.header} className={c.className}><div className="cell">{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}</div></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <nav className="kiu-row" style={{ justifyContent: 'space-between', marginTop: 12 }} aria-label="Pagination">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="muted" aria-live="polite">Page {page} of {totalPages} · {total} total</span>
      <Button variant="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

/** Modal dialog: labelled, Escape closes, focus moves in and returns to the opener, background scroll locked. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (f.length === 0) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = prev; opener?.focus?.(); };
  }, [onClose]);
  return (
    <div className="kiu-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="kiu-modal kiu-pop" role="dialog" aria-modal="true" aria-labelledby={titleId} style={wide ? { maxWidth: 820 } : undefined}>
        <div className="kiu-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <h2 id={titleId} style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="kiu-iconbtn" aria-label="Close dialog" data-close onClick={onClose}><X size={20} aria-hidden /></button>
        </div>
        <div className="kiu-stack" style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

/** Accessible bar chart: SVG bars with a text summary for screen readers (values also appear in the table beside it). */
export function BarChart({ data, label, height = 120 }: { data: { label: string; a: number; b: number }[]; label: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.a + d.b));
  const w = Math.max(1, data.length) * 26;
  return (
    <figure style={{ margin: 0 }}>
      <svg role="img" aria-label={`${label}. ${data.map((d) => `${d.label}: ${d.a} granted, ${d.b} denied`).join('; ') || 'No data'}`} viewBox={`0 0 ${w} ${height + 18}`} width="100%" preserveAspectRatio="none" style={{ maxHeight: height + 18 }}>
        {data.map((d, i) => {
          const ha = (d.a / max) * height, hb = (d.b / max) * height;
          return (
            <g key={d.label} transform={`translate(${i * 26 + 4},0)`}>
              <rect y={height - ha - hb} width="18" height={hb} fill="var(--deny)" stroke="var(--ink)" strokeWidth="1" />
              <rect y={height - ha} width="18" height={ha} fill="var(--grant)" stroke="var(--ink)" strokeWidth="1" />
              <text x="9" y={height + 12} textAnchor="middle" fontSize="8" fill="var(--text-2)">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="kiu-hint">■ granted (green) &nbsp; ■ denied (red)</figcaption>
    </figure>
  );
}
