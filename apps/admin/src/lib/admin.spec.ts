import { PERMISSIONS, ROLE_DEFINITIONS } from '@kiu/shared';
import { describe, expect, it } from 'vitest';
import { can, type Me } from './auth';
import { ROUTE_META, visibleRoutes } from './nav';
import { qs } from './hooks';

const me = (permissions: string[]): Me => ({ id: '1', email: 'a@b.test', displayName: 'A', userType: 'STAFF', roles: [], permissions, mfaEnabled: true, mfaSetupRequired: false });
const roleRoutes = (code: string) => visibleRoutes(ROLE_DEFINITIONS.find((r) => r.code === code)!.permissions).map((r) => r.label);

describe('console navigation vs the permission catalogue', () => {
  it('only requires permissions that actually exist (guards against typos that would hide a page forever)', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const r of ROUTE_META) for (const p of r.perms) expect(known.has(p), `${r.label}: unknown permission ${p}`).toBe(true);
  });

  it('has unique paths', () => {
    expect(new Set(ROUTE_META.map((r) => r.path)).size).toBe(ROUTE_META.length);
  });

  it('shows a Super Administrator every page', () => {
    expect(roleRoutes('SUPER_ADMIN')).toEqual(ROUTE_META.map((r) => r.label));
  });

  it('shows students no console page at all', () => {
    expect(roleRoutes('STUDENT')).toEqual([]);
  });

  it.each([
    ['MANAGEMENT', ['Overview', 'Reports', 'Access logs', 'Alerts', 'Audit trail']],
    ['CARD_OFFICER', ['Students', 'Cards', 'Access logs']],
    ['FINANCE_OFFICER', ['Overview', 'Students', 'Finance', 'Data imports', 'Reports']],
    ['HOSTEL_WARDEN', ['Overview', 'Students', 'Hostels', 'Reports', 'Access logs']],
    ['CAFETERIA_OPERATOR', ['Meal sittings']],
    ['LIBRARIAN', ['Overview', 'Students', 'Library', 'Reports']],
    ['SECURITY_OFFICER', ['Overview', 'Students', 'Readers', 'Reports', 'Access logs', 'Alerts', 'Overrides']],
  ])('gives %s exactly the pages its permissions allow', (code, labels) => {
    expect(roleRoutes(code).sort()).toEqual([...labels].sort());
  });

  it('never exposes user administration, rules or audit to operational roles', () => {
    for (const code of ['SECURITY_OFFICER', 'INVIGILATOR', 'LIBRARIAN', 'CAFETERIA_OPERATOR', 'HOSTEL_WARDEN', 'FINANCE_OFFICER', 'CARD_OFFICER']) {
      const labels = roleRoutes(code);
      for (const forbidden of ['Staff & roles', 'Rules', 'Audit trail']) expect(labels, `${code} should not see ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('helpers', () => {
  it('can() requires ALL listed permissions', () => {
    expect(can(me(['a', 'b']), 'a', 'b')).toBe(true);
    expect(can(me(['a']), 'a', 'b')).toBe(false);
    expect(can(me([]))).toBe(true);
  });

  it('qs() builds a query string, skipping empty values and encoding the rest', () => {
    expect(qs({})).toBe('');
    expect(qs({ q: ' a b&c ', page: 2, x: undefined, y: '', z: null })).toBe('?q=%20a%20b%26c%20&page=2');
  });
});
