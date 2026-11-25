import { Harness, bearer, createStaff, loginBearer, startHarness, uniqueEmail, TEST_PASSWORD } from './harness';
import * as argon2 from 'argon2';

describe('RBAC and privilege escalation (e2e)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  async function tokenFor(roleCodes: string[]) {
    const u = await createStaff(h.prisma, roleCodes);
    const { token } = await loginBearer(h, u.email, u.password);
    // SUPER_ADMIN/ICT_ADMIN sessions start in the MFA-setup-only state. Marking MFA as enrolled
    // lifts the gate on the live token immediately because the guard re-reads user state per request.
    if (roleCodes.some((r) => r === 'SUPER_ADMIN' || r === 'ICT_ADMIN')) {
      await h.prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
    }
    return { ...u, token };
  }

  async function studentToken() {
    const prog = await h.prisma.programme.findFirst() ?? await (async () => {
      const d = await h.prisma.department.create({ data: { code: `D${Date.now()}`, name: 'Dept', faculty: 'F' } });
      return h.prisma.programme.create({ data: { code: `P${Date.now()}`, name: 'Prog', departmentId: d.id } });
    })();
    const email = uniqueEmail('student');
    const student = await h.prisma.student.create({ data: { regNo: `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, fullName: 'Test Student', programmeId: prog.id, yearOfStudy: 1 } });
    const role = await h.prisma.role.findUniqueOrThrow({ where: { code: 'STUDENT' } });
    await h.prisma.user.create({
      data: {
        email, displayName: 'Test Student', userType: 'STUDENT', studentId: student.id,
        passwordHash: await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
        roles: { create: [{ roleId: role.id }] },
      },
    });
    const { token } = await loginBearer(h, email);
    return { token, studentId: student.id };
  }

  it('denies a student every staff/administrative endpoint', async () => {
    const { token, studentId } = await studentToken();
    for (const path of ['/students', `/students/${studentId}`, '/users', '/roles', '/permissions', '/audit', '/audit/verify']) {
      const res = await h.http().get(`/api/v1${path}`).set(bearer(token));
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    await h.http().post('/api/v1/students').set(bearer(token)).send({}).expect(403);
    await h.http().post('/api/v1/users').set(bearer(token)).send({}).expect(403);
  });

  it('lets a student read only their own profile via /auth/me', async () => {
    const { token, studentId } = await studentToken();
    const me = await h.http().get('/api/v1/auth/me').set(bearer(token)).expect(200);
    expect(me.body.roles).toEqual(['STUDENT']);
    expect(me.body.student.id).toBe(studentId);
    expect(me.body.permissions.every((p: string) => p.startsWith('me.'))).toBe(true);
  });

  it('grants least-privilege access per role', async () => {
    const security = await tokenFor(['SECURITY_OFFICER']);
    await h.http().get('/api/v1/students').set(bearer(security.token)).expect(200);
    await h.http().post('/api/v1/students').set(bearer(security.token)).send({}).expect(403);
    await h.http().get('/api/v1/users').set(bearer(security.token)).expect(403);
    await h.http().get('/api/v1/audit').set(bearer(security.token)).expect(403);

    const mgmt = await tokenFor(['MANAGEMENT']);
    await h.http().get('/api/v1/audit').set(bearer(mgmt.token)).expect(200);
    await h.http().get('/api/v1/students').set(bearer(mgmt.token)).expect(403);

    const cafe = await tokenFor(['CAFETERIA_OPERATOR']);
    await h.http().get('/api/v1/students').set(bearer(cafe.token)).expect(403);
  });

  describe('user management escalation controls', () => {
    it('stops an ICT Admin granting SUPER_ADMIN, or touching a Super Admin', async () => {
      const ict = await tokenFor(['ICT_ADMIN']);
      const target = await createStaff(h.prisma, ['LIBRARIAN']);
      const sa = await createStaff(h.prisma, ['SUPER_ADMIN']);

      const grant = await h.http().patch(`/api/v1/users/${target.id}`).set(bearer(ict.token))
        .send({ roleCodes: ['SUPER_ADMIN'], reason: 'please' }).expect(403);
      expect(grant.body.code).toBe('ESCALATION_BLOCKED');

      const create = await h.http().post('/api/v1/users').set(bearer(ict.token))
        .send({ email: uniqueEmail('evil'), displayName: 'Evil Admin', password: 'Strong-Passphrase-31!', roleCodes: ['SUPER_ADMIN'] }).expect(403);
      expect(create.body.code).toBe('ESCALATION_BLOCKED');

      const touch = await h.http().patch(`/api/v1/users/${sa.id}`).set(bearer(ict.token)).send({ displayName: 'Pwned' }).expect(403);
      expect(touch.body.code).toBe('ESCALATION_BLOCKED');

      const roles = await h.prisma.userRole.findMany({ where: { userId: target.id }, include: { role: true } });
      expect(roles.map((r) => r.role.code)).toEqual(['LIBRARIAN']);
    });

    it('lets a Super Admin grant roles, requires a reason, and signs the target out', async () => {
      const sa = await tokenFor(['SUPER_ADMIN']);
      const target = await createStaff(h.prisma, ['LIBRARIAN']);
      const t = await loginBearer(h, target.email, target.password);

      await h.http().patch(`/api/v1/users/${target.id}`).set(bearer(sa.token)).send({ roleCodes: ['FINANCE_OFFICER'] }).expect(400)
        .expect((r) => expect(r.body.code).toBe('REASON_REQUIRED'));

      const res = await h.http().patch(`/api/v1/users/${target.id}`).set(bearer(sa.token))
        .send({ roleCodes: ['FINANCE_OFFICER'], reason: 'Transferred to finance office' }).expect(200);
      expect(res.body.roles).toEqual(['FINANCE_OFFICER']);
      await h.http().get('/api/v1/auth/me').set(bearer(t.token)).expect(401); // stale permissions cannot linger

      const audit = await h.prisma.auditTrail.findFirst({ where: { action: 'users.update', entityId: target.id } });
      expect(audit?.reason).toBe('Transferred to finance office');
      expect(JSON.stringify(audit?.before)).toContain('LIBRARIAN');
      expect(JSON.stringify(audit?.after)).toContain('FINANCE_OFFICER');
    });

    it('blocks self-modification of roles and status', async () => {
      const ict = await tokenFor(['ICT_ADMIN']);
      const res = await h.http().patch(`/api/v1/users/${ict.id}`).set(bearer(ict.token)).send({ roleCodes: ['SUPER_ADMIN'], reason: 'self promote' }).expect(403);
      expect(res.body.code).toBe('SELF_MODIFICATION_BLOCKED');
    });

    it('refuses to hand out the STUDENT role or unknown roles to staff', async () => {
      const sa = await tokenFor(['SUPER_ADMIN']);
      const target = await createStaff(h.prisma, ['LIBRARIAN']);
      await h.http().patch(`/api/v1/users/${target.id}`).set(bearer(sa.token)).send({ roleCodes: ['STUDENT'], reason: 'x test' }).expect(400)
        .expect((r) => expect(r.body.code).toBe('ROLE_NOT_ASSIGNABLE'));
      await h.http().patch(`/api/v1/users/${target.id}`).set(bearer(sa.token)).send({ roleCodes: ['NOPE'], reason: 'x test' }).expect(400)
        .expect((r) => expect(r.body.code).toBe('UNKNOWN_ROLE'));
    });

    it('creates users with a policy-compliant password and rejects duplicates', async () => {
      const sa = await tokenFor(['SUPER_ADMIN']);
      const email = uniqueEmail('newhire');
      const weak = await h.http().post('/api/v1/users').set(bearer(sa.token)).send({ email, displayName: 'New Hire', password: 'short', roleCodes: ['LIBRARIAN'] }).expect(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');
      const ok = await h.http().post('/api/v1/users').set(bearer(sa.token)).send({ email, displayName: 'New Hire', password: 'Welcome-Aboard-2026!', roleCodes: ['LIBRARIAN'] }).expect(201);
      expect(ok.body).not.toHaveProperty('passwordHash');
      await h.http().post('/api/v1/users').set(bearer(sa.token)).send({ email, displayName: 'New Hire', password: 'Welcome-Aboard-2026!', roleCodes: ['LIBRARIAN'] }).expect(409);
      const created = await h.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(created.mustChangePassword).toBe(true);
    });
  });

  it('keeps audit entries free of credentials', async () => {
    const sa = await tokenFor(['SUPER_ADMIN']);
    const email = uniqueEmail('redact');
    const created = await h.http().post('/api/v1/users').set(bearer(sa.token)).send({ email, displayName: 'Redact Me', password: 'Welcome-Aboard-2026!', roleCodes: ['LIBRARIAN'] }).expect(201);
    const rows = await h.prisma.auditTrail.findMany({ where: { action: 'users.create', entityId: created.body.id } });
    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialised).toContain('Redact Me'); // the entry is real and populated...
    expect(serialised).not.toMatch(/Welcome-Aboard|argon2|passwordHash/); // ...yet carries no credential material
  });
});
