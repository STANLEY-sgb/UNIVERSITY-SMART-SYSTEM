import { MFA_REQUIRED_ROLES, PERMISSIONS, ROLE_CODES, ROLE_DEFINITIONS, permissionsForRoles } from './permissions';

describe('role/permission catalogue', () => {
  it('defines every role code exactly once', () => {
    expect(ROLE_DEFINITIONS.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort());
  });

  it('only references permissions that exist', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of ROLE_DEFINITIONS) {
      for (const p of role.permissions) expect(known.has(p)).toBe(true);
    }
  });

  it('keeps students restricted to self-service permissions', () => {
    const student = ROLE_DEFINITIONS.find((r) => r.code === 'STUDENT')!;
    expect(student.permissions.every((p) => p.startsWith('me.'))).toBe(true);
  });

  it('does not let operational roles manage users, roles or rules', () => {
    for (const code of ['SECURITY_OFFICER', 'INVIGILATOR', 'LIBRARIAN', 'CAFETERIA_OPERATOR', 'HOSTEL_WARDEN'] as const) {
      const perms = permissionsForRoles([code]);
      expect(perms).not.toContain('users.manage');
      expect(perms).not.toContain('roles.manage');
      expect(perms).not.toContain('rules.manage');
    }
  });

  it('requires MFA for privileged administrators', () => {
    expect(MFA_REQUIRED_ROLES).toEqual(expect.arrayContaining(['SUPER_ADMIN', 'ICT_ADMIN']));
  });

  it('unions permissions across multiple roles', () => {
    const perms = permissionsForRoles(['LIBRARIAN', 'CARD_OFFICER']);
    expect(perms).toEqual(expect.arrayContaining(['library.manage', 'cards.issue']));
  });
});
