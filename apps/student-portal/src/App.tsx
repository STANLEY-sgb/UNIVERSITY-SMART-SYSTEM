import { Banner, Card, Nav, Skeleton, type NavItem } from '@kiu/ui';
import { Bell, History, Home, ShieldCheck, User, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './lib/api';
import { CardPage } from './pages/Card';
import { AccessPage, AccountPage, FaceNeedBanner, HistoryPage, Login, NotificationsPage, Register } from './pages/Pages';

interface Me { id: string; email: string; displayName: string; userType: string; student: { id: string; regNo: string; fullName: string } | null }

const ROUTES = ['/', '/card', '/access', '/history', '/notifications', '/account'] as const;
const route = () => (ROUTES as readonly string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) : '/';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [path, setPath] = useState(route());
  const [unread, setUnread] = useState(0);
  const [signedOutView, setSignedOutView] = useState<'login' | 'register'>('login');

  const loadMe = useCallback(async () => {
    try { setMe(await api<Me>('GET', '/auth/me')); }
    catch (e) { setMe(e instanceof ApiError && e.status === 401 ? null : null); }
  }, []);
  const loadUnread = useCallback(() => { api<{ unread: number }>('GET', '/me/notifications?pageSize=1').then((r) => setUnread(r.unread)).catch(() => undefined); }, []);

  useEffect(() => { void loadMe(); }, [loadMe]);
  useEffect(() => { if (me) loadUnread(); }, [me, loadUnread]);
  useEffect(() => {
    const on = () => setPath(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (me === undefined) return <main className="kiu-page"><Skeleton h={120} /></main>;
  if (me === null) {
    return signedOutView === 'register'
      ? <Register onRegistered={() => void loadMe()} onBack={() => setSignedOutView('login')} />
      : <Login onLoggedIn={() => void loadMe()} onCreateAccount={() => setSignedOutView('register')} />;
  }

  const go = (to: string) => { location.hash = to; };
  const items: NavItem[] = [
    { to: '/', label: 'Home', icon: <Home size={20} aria-hidden /> },
    { to: '/card', label: 'My card', icon: <Wallet size={20} aria-hidden /> },
    { to: '/access', label: 'My access', icon: <ShieldCheck size={20} aria-hidden /> },
    { to: '/history', label: 'History', icon: <History size={20} aria-hidden /> },
    { to: '/notifications', label: unread ? `Alerts (${unread})` : 'Alerts', icon: <Bell size={20} aria-hidden /> },
    { to: '/account', label: 'Account', icon: <User size={20} aria-hidden /> },
  ];
  const logout = async () => { await api('POST', '/auth/logout', {}).catch(() => undefined); setMe(null); };

  return (
    <>
      <Nav items={items} current={path} onNavigate={go} />
      <main className="kiu-page">
        {path === '/' && (
          <div className="kiu-stack">
            <h1>Hello, {(me.student?.fullName ?? me.displayName).split(' ')[0]}</h1>
            <FaceNeedBanner />
            <Card className="kiu-stack" accent="aqua">
              <h2>Your access today</h2>
              <AccessPage summary />
              <a href="#/access" className="kiu-btn secondary" style={{ textDecoration: 'none', width: 'fit-content' }}>See all services</a>
            </Card>
            {unread > 0 && <Banner tone="info">You have {unread} unread notification{unread === 1 ? '' : 's'}.</Banner>}
          </div>
        )}
        {path === '/card' && <><h1>My card</h1><CardPage me={me} /></>}
        {path === '/access' && <><h1>My access</h1><AccessPage /></>}
        {path === '/history' && <><h1>Access history</h1><HistoryPage /></>}
        {path === '/notifications' && <><h1>Notifications</h1><NotificationsPage onRead={loadUnread} /></>}
        {path === '/account' && <><h1>Account</h1><AccountPage me={me} onLogout={() => void logout()} /></>}
      </main>
    </>
  );
}
