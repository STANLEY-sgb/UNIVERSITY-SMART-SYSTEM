import { Banner, Button, Skeleton } from '@kiu/ui';
import { Activity, Bell, CreditCard, GraduationCap, LogOut, Menu, Radio, ScrollText, ShieldCheck, Users as UsersIcon, X, ClipboardList, Wallet, BookOpen, Building2, Utensils, CalendarDays, Upload, BarChart3, FileCheck2, ScanFace, Settings as SettingsIcon, ShieldAlert, Landmark } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './lib/api';
import { can, type Me } from './lib/auth';
import { ROUTE_META } from './lib/nav';
import { Cards } from './pages/Cards';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Readers } from './pages/Readers';
import { Alerts, Audit, Logs, Users } from './pages/Records';
import { Rules } from './pages/Rules';
import { Students } from './pages/Students';
import { Academic, Hostels, Meals, Timetable } from './pages/Campus';
import { Imports } from './pages/Imports';
import { Reports } from './pages/Reports';
import { Exams } from './pages/Exams';
import { Biometrics } from './pages/Biometrics';
import { Settings } from './pages/Settings';
import { Overrides } from './pages/Overrides';
import { Finance, Library } from './pages/University';

const ICONS: Record<string, ReactNode> = {
  '/': <Activity size={18} aria-hidden />, '/academic': <Landmark size={18} aria-hidden />, '/students': <GraduationCap size={18} aria-hidden />, '/cards': <CreditCard size={18} aria-hidden />,
  '/readers': <Radio size={18} aria-hidden />, '/rules': <ClipboardList size={18} aria-hidden />, '/finance': <Wallet size={18} aria-hidden />, '/library': <BookOpen size={18} aria-hidden />,
  '/hostels': <Building2 size={18} aria-hidden />, '/meals': <Utensils size={18} aria-hidden />, '/timetable': <CalendarDays size={18} aria-hidden />,
  '/imports': <Upload size={18} aria-hidden />, '/reports': <BarChart3 size={18} aria-hidden />, '/exams': <FileCheck2 size={18} aria-hidden />, '/face': <ScanFace size={18} aria-hidden />, '/settings': <SettingsIcon size={18} aria-hidden />, '/overrides': <ShieldAlert size={18} aria-hidden />,
  '/logs': <ScrollText size={18} aria-hidden />,
  '/alerts': <Bell size={18} aria-hidden />, '/audit': <ShieldCheck size={18} aria-hidden />, '/users': <UsersIcon size={18} aria-hidden />,
};
const PAGES: Record<string, (me: Me) => ReactNode> = {
  '/': () => <Overview />, '/academic': (me) => <Academic me={me} />, '/students': (me) => <Students me={me} />, '/cards': (me) => <Cards me={me} />, '/readers': (me) => <Readers me={me} />,
  '/rules': (me) => <Rules me={me} />, '/finance': (me) => <Finance me={me} />, '/library': (me) => <Library me={me} />, '/hostels': (me) => <Hostels me={me} />, '/meals': (me) => <Meals me={me} />, '/timetable': (me) => <Timetable me={me} />, '/imports': (me) => <Imports me={me} />, '/reports': (me) => <Reports me={me} />, '/exams': (me) => <Exams me={me} />, '/face': (me) => <Biometrics me={me} />, '/settings': () => <Settings />, '/overrides': (me) => <Overrides me={me} />, '/logs': () => <Logs />, '/alerts': (me) => <Alerts me={me} />, '/audit': () => <Audit />, '/users': (me) => <Users me={me} />,
};
const ROUTES = ROUTE_META.map((m) => ({ ...m, icon: ICONS[m.path], render: PAGES[m.path]! }));

const hash = () => location.hash.slice(1) || '/';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [path, setPath] = useState(hash());
  const [menu, setMenu] = useState(false);

  const load = useCallback(async () => { try { setMe(await api<Me>('GET', '/auth/me')); } catch { setMe(null); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const on = () => { setPath(hash()); setMenu(false); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (me === undefined) return <main className="kiu-page"><Skeleton h={120} /></main>;
  if (me === null || me.userType !== 'STAFF') return <Login onDone={() => void load()} />;

  const allowed = ROUTES.filter((r) => can(me, ...r.perms));
  const current = allowed.find((r) => r.path === path) ?? null;
  const fallback = allowed[0];

  return (
    <div className="kiu-shell">
      <aside className="kiu-side" data-open={menu} aria-label="Sidebar">
        <div className="kiu-row" style={{ justifyContent: 'space-between', padding: '6px 12px 14px' }}>
          <strong style={{ fontFamily: 'var(--font-head)', fontSize: '1.15rem', color: 'var(--yellow)' }}>KIU Admin</strong>
          <button type="button" className="kiu-iconbtn kiu-menu-btn" aria-label="Close menu" onClick={() => setMenu(false)}><X size={20} aria-hidden /></button>
        </div>
        <nav aria-label="Primary">
          {allowed.map((r) => <a key={r.path} href={`#${r.path}`} aria-current={current?.path === r.path ? 'page' : undefined}>{r.icon}{r.label}</a>)}
        </nav>
      </aside>
      <div>
        <header className="kiu-top">
          <button type="button" className="kiu-iconbtn kiu-menu-btn" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu(true)} data-testid="menu-btn"><Menu size={20} aria-hidden /></button>
          <span className="muted" data-testid="whoami" style={{ marginLeft: 'auto' }}>{me.displayName} · {me.roles.join(', ')}</span>
          <Button variant="secondary" data-testid="signout" onClick={async () => { await api('POST', '/auth/logout', {}).catch(() => undefined); setMe(null); }}><LogOut size={16} aria-hidden /> Sign out</Button>
        </header>
        <main className="kiu-main" id="main">
          {current ? current.render(me)
            : fallback ? <Banner tone="warn">You do not have access to that page. <a href={`#${fallback.path}`}>Go to {fallback.label}</a>.</Banner>
            : <Banner tone="warn">Your account has no console permissions yet. Ask an administrator.</Banner>}
        </main>
      </div>
      {menu && <div className="kiu-backdrop" style={{ zIndex: 30 }} aria-hidden onClick={() => setMenu(false)} />}
    </div>
  );
}
