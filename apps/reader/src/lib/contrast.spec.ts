import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.x contrast guard computed straight from tokens.css. axe cannot judge text over gradients or CSS variables it
 * cannot resolve, so this protects the combinations it is blind to (ID card gradient, status chips).
 */
const css = readFileSync(fileURLToPath(new URL('../../../../packages/ui/src/tokens.css', import.meta.url)), 'utf8');

const vars = new Map<string, string>();
for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) vars.set(m[1]!, m[2]!);
const v = (name: string) => { const x = vars.get(name); if (!x) throw new Error(`token --${name} not found`); return x; };

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

const alpha = Number(/--panel-alpha:\s*([\d.]+)/.exec(css)?.[1]);
/** Content sits on a frosted white panel; check text against the panel composited over EVERY artwork colour. */
const PANEL_WORST = ['plum', 'violet', 'magenta', 'teal', 'aqua', 'cyan', 'lime', 'sun'].map(v);
const over = (bg: string) => {
  const n = parseInt(bg.slice(1), 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(255 * alpha + c * (1 - alpha)));
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
};

describe('design-token contrast (WCAG AA, normal text 4.5:1)', () => {
  const pairs: [string, string, string][] = [
    ['text on canvas', v('text'), v('canvas')],
    ...PANEL_WORST.map((bg, i): [string, string, string] => [`text on frosted panel over artwork colour ${i + 1} (${bg})`, v('text'), over(bg)]),
    ['secondary text on white', v('text-2'), '#FFFFFF'],
    ['secondary text on canvas', v('text-2'), v('canvas')],
    ...PANEL_WORST.map((bg, i): [string, string, string] => [`secondary text on frosted panel over artwork colour ${i + 1}`, v('text-2'), over(bg)]),
    ['GRANT chip', v('grant'), v('grant-bg')],
    ['DENY chip', v('deny'), v('deny-bg')],
    ['WARN chip', v('warn'), v('warn-bg')],
    ['INFO chip', v('info'), v('info-bg')],
    ['white on danger button', '#FFFFFF', v('deny')],
    ['white on ink button', '#FFFFFF', v('ink')],
    ['ink on primary teal button', v('ink'), v('teal')],
    ['ink on aqua tile and avatar', v('ink'), v('aqua')],
    ['ink on sun-yellow accents (nav, badges, codes)', v('ink'), v('yellow')],
    ['white on plum sidebar', '#FFFFFF', v('plum')],
    ['ink on yellow active nav item', v('ink'), v('yellow')],
    ['GRANT text on result panel', v('grant'), v('grant-bg')],
    ['DENY text on result panel', v('deny'), v('deny-bg')],
  ];
  it.each(pairs)('%s', (_n, fg, bg) => expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5));

  it('white text holds AA across the WHOLE student-ID-card gradient and on the purple accent card', () => {
    const g = /\.kiu-idcard\s*\{[^}]*linear-gradient\([^,]+,\s*(#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/.exec(css);
    expect(g).not.toBeNull();
    for (const stop of [g![1]!, g![2]!]) expect(ratio('#FFFFFF', stop)).toBeGreaterThanOrEqual(4.5);
    const accent = /\.kiu-card\.accent-purple\s*\{\s*background:\s*(#[0-9A-Fa-f]{6})/.exec(css);
    expect(accent).not.toBeNull();
    expect(ratio('#FFFFFF', accent![1]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the note text on the card is also readable', () => {
    expect(ratio('#F3DDFB', '#6A0090')).toBeGreaterThanOrEqual(4.5);
  });
});
