import { authenticator } from 'otplib';
import { Harness, TEST_PASSWORD, bearer, createStaff, loginBearer, startHarness, uniqueEmail } from './harness';
import { makeStudent } from './access-fixtures';
import { MailService } from '../modules/mail/mail.service';
import { seedDemo } from '../seed/demo';

describe('auth (e2e, real PostgreSQL)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); await seedDemo(h.prisma, { students: 0 }); }, 60_000);
  afterAll(async () => { await h.close(); });

  it('exposes a public health check backed by the database', async () => {
    const res = await h.http().get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const res = await h.http().get('/api/v1/students').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(res.body.requestId).toBeDefined();
  });

  describe('login', () => {
    it('returns an identical generic error for wrong password and unknown email (no enumeration)', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const wrong = await h.http().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-Password-123!' }).expect(401);
      const unknown = await h.http().post('/api/v1/auth/login').send({ email: uniqueEmail('ghost'), password: 'Wrong-Password-123!' }).expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.message).toBe(unknown.body.message);
      expect(wrong.body.code).toBe(unknown.body.code);
    });

    it('sets HttpOnly cookies and keeps tokens out of the body by default', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const res = await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
      expect(cookies).toMatch(/kiu_at=[^;]+;.*HttpOnly/i);
      expect(cookies).toMatch(/kiu_rt=[^;]+;.*Path=\/api\/v1\/auth;.*HttpOnly;.*SameSite=Strict/i);
      expect(cookies).toMatch(/kiu_csrf=/);
      expect(cookies.match(/kiu_csrf=[^\n]*/)?.[0]).not.toMatch(/HttpOnly/i);
    });

    it('stores passwords as Argon2id and never returns hashes', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const row = await h.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
      const { token } = await loginBearer(h, u.email, u.password);
      const me = await h.http().get('/api/v1/auth/me').set(bearer(token)).expect(200);
      expect(JSON.stringify(me.body)).not.toMatch(/argon2|passwordHash|password_hash/i);
    });

    it('validates input and rejects unknown fields', async () => {
      const res = await h.http().post('/api/v1/auth/login').send({ email: 'not-an-email', password: 'x', admin: true }).expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it('locks the account after repeated failures, even for the correct password', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      for (let i = 0; i < 5; i++) {
        await h.http().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-Password-123!' }).expect(401);
      }
      const locked = await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(423);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      const actions = (await h.prisma.auditTrail.findMany({ where: { entityId: u.id } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.account_locked', 'auth.login_blocked_locked']));
    });

    it('refuses disabled accounts with the generic error', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      await h.prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
      const res = await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('sessions and refresh rotation', () => {
    it('rotates refresh tokens and revokes the whole family on reuse', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const first = await loginBearer(h, u.email, u.password);
      const second = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: first.refresh }).expect(200);
      expect(second.body.refreshToken).toBeDefined();
      expect(second.body.refreshToken).not.toBe(first.refresh);

      // Attacker replays the already-rotated token -> family is burned.
      await h.http().post('/api/v1/auth/refresh').send({ refreshToken: first.refresh }).expect(401);
      await h.http().post('/api/v1/auth/refresh').send({ refreshToken: second.body.refreshToken }).expect(401);
      await h.http().get('/api/v1/auth/me').set(bearer(second.body.accessToken)).expect(401);
      const reuse = await h.prisma.auditTrail.findFirst({ where: { action: 'auth.refresh_reuse_detected', actorId: u.id } });
      expect(reuse).not.toBeNull();
    });

    it('does not hand tokens to scripts that merely trigger a cookie-based refresh', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const agent = h.http();
      const login = await agent.post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
      const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
      const res = await h.http().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Token-Delivery', 'body').send({}).expect(200);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('logout invalidates the session immediately (not at token expiry)', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const { token } = await loginBearer(h, u.email, u.password);
      await h.http().get('/api/v1/auth/me').set(bearer(token)).expect(200);
      await h.http().post('/api/v1/auth/logout').set(bearer(token)).expect(204);
      await h.http().get('/api/v1/auth/me').set(bearer(token)).expect(401);
    });

    it('rejects forged and tampered tokens', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const { token } = await loginBearer(h, u.email, u.password);
      const [hd, pl, sig] = token!.split('.');
      const tampered = [hd, Buffer.from(JSON.stringify({ sub: u.id, sid: 'x', exp: 9999999999 })).toString('base64url'), sig].join('.');
      await h.http().get('/api/v1/auth/me').set(bearer(tampered)).expect(401);
      const none = [Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), pl, ''].join('.');
      await h.http().get('/api/v1/auth/me').set(bearer(none)).expect(401);
    });

    it('disabling a user kills their live sessions at once', async () => {
      const admin = await createStaff(h.prisma, ['SUPER_ADMIN']);
      await h.prisma.user.update({ where: { id: admin.id }, data: { mfaEnabled: true } }); // skip MFA gate for this scenario
      const victim = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const v = await loginBearer(h, victim.email, victim.password);
      await h.http().get('/api/v1/auth/me').set(bearer(v.token)).expect(200);
      await h.prisma.user.update({ where: { id: victim.id }, data: { status: 'SUSPENDED' } });
      await h.http().get('/api/v1/auth/me').set(bearer(v.token)).expect(401);
    });
  });

  describe('CSRF protection for cookie sessions', () => {
    it('blocks cookie-authenticated unsafe requests without the CSRF header, allows them with it', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const login = await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
      const jar = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
      const csrf = jar.find((c) => c.startsWith('kiu_csrf='))!.split('=')[1]!;
      const cookie = jar.join('; ');

      await h.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200); // safe method: fine
      const blocked = await h.http().post('/api/v1/auth/logout').set('Cookie', cookie).expect(403);
      expect(blocked.body.code).toBe('CSRF_FAILED');
      await h.http().post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', 'wrong').expect(403);
      await h.http().post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(204);
    });
  });

  describe('MFA for privileged roles', () => {
    it('confines an un-enrolled Super Admin to MFA setup, then enforces TOTP and single-use recovery codes', async () => {
      const admin = await createStaff(h.prisma, ['SUPER_ADMIN']);
      const first = await loginBearer(h, admin.email, admin.password);
      expect(first.res.body.mfaSetupRequired).toBe(true);

      const blocked = await h.http().get('/api/v1/students').set(bearer(first.token)).expect(403);
      expect(blocked.body.code).toBe('MFA_ENROLMENT_REQUIRED');
      await h.http().get('/api/v1/auth/me').set(bearer(first.token)).expect(200);

      const setup = await h.http().post('/api/v1/auth/mfa/setup').set(bearer(first.token)).expect(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const row = await h.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(row.mfaSecretEnc?.startsWith('v1.')).toBe(true); // encrypted at rest
      expect(row.mfaSecretEnc).not.toContain(setup.body.secret);

      await h.http().post('/api/v1/auth/mfa/enable').set(bearer(first.token)).send({ code: '000000' }).expect(400);
      const enabled = await h.http().post('/api/v1/auth/mfa/enable').set(bearer(first.token)).send({ code: authenticator.generate(setup.body.secret) }).expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(8);

      // Gate lifted immediately on the same session.
      await h.http().get('/api/v1/students').set(bearer(first.token)).expect(200);

      // New logins now need a second factor.
      const noCode = await h.http().post('/api/v1/auth/login').send({ email: admin.email, password: admin.password }).expect(401);
      expect(noCode.body.code).toBe('MFA_REQUIRED');
      const badCode = await h.http().post('/api/v1/auth/login').send({ email: admin.email, password: admin.password, mfaCode: '123456' }).expect(401);
      expect(badCode.body.code).toBe('MFA_INVALID');
      const ok = await loginBearer(h, admin.email, admin.password, authenticator.generate(setup.body.secret));
      expect(ok.res.status).toBe(200);
      expect(ok.res.body.mfaSetupRequired).toBe(false);

      const recovery = enabled.body.recoveryCodes[0] as string;
      expect((await loginBearer(h, admin.email, admin.password, recovery)).res.status).toBe(200);
      expect((await loginBearer(h, admin.email, admin.password, recovery)).res.status).toBe(401); // single use
    });

    it('does not force MFA on roles outside the privileged set', async () => {
      const u = await createStaff(h.prisma, ['LIBRARIAN']);
      const { res } = await loginBearer(h, u.email, u.password);
      expect(res.body.mfaSetupRequired).toBe(false);
    });
  });

  describe('password recovery and change', () => {
    it('resets via a single-use token, then revokes every session', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const live = await loginBearer(h, u.email, u.password);
      const mail = h.app.get(MailService);

      const unknown = await h.http().post('/api/v1/auth/forgot-password').send({ email: uniqueEmail('nobody') }).expect(202);
      const known = await h.http().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(202);
      expect(known.body).toEqual(unknown.body); // identical response

      const token = mail.outbox.filter((m) => m.to === u.email).at(-1)!.text.split(': ').at(-1)!;
      const stored = await h.prisma.passwordResetToken.findMany({ where: { userId: u.id } });
      expect(stored.every((t) => t.tokenHash !== token)).toBe(true); // only a hash is stored

      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'short' }).expect(400);
      const newPassword = 'Brand-New-Passphrase-77!';
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword }).expect(204);
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Another-Passphrase-88!' }).expect(400); // reuse

      await h.http().get('/api/v1/auth/me').set(bearer(live.token)).expect(401);
      await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(401);
      expect((await loginBearer(h, u.email, newPassword)).res.status).toBe(200);
    });

    it('lets a locked-out user recover by resetting their password', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      for (let i = 0; i < 5; i++) await h.http().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-Password-123!' });
      await h.http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(423);
      await h.http().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(202);
      const token = h.app.get(MailService).outbox.filter((m) => m.to === u.email).at(-1)!.text.split(': ').at(-1)!;
      await h.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Recovered-Passphrase-55!' }).expect(204);
      expect((await loginBearer(h, u.email, 'Recovered-Passphrase-55!')).res.status).toBe(200);
    });

    it('enforces the password policy on change and keeps the current session alive', async () => {
      const u = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const a = await loginBearer(h, u.email, u.password);
      const b = await loginBearer(h, u.email, u.password);
      await h.http().post('/api/v1/auth/change-password').set(bearer(a.token)).send({ currentPassword: 'nope', newPassword: 'Valid-New-Password-12!' }).expect(401);
      const weak = await h.http().post('/api/v1/auth/change-password').set(bearer(a.token)).send({ currentPassword: u.password, newPassword: 'aaaaaaaaaaaa' }).expect(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');
      await h.http().post('/api/v1/auth/change-password').set(bearer(a.token)).send({ currentPassword: u.password, newPassword: 'Valid-New-Password-12!' }).expect(204);
      await h.http().get('/api/v1/auth/me').set(bearer(a.token)).expect(200);
      await h.http().get('/api/v1/auth/me').set(bearer(b.token)).expect(401); // other devices signed out
    });
  });

  describe('student self-registration', () => {
    it('claims the first sign-in for a student record Registry already created', async () => {
      const student = await makeStudent(h.prisma);
      const email = uniqueEmail('newstudent');
      const res = await h.http().post('/api/v1/auth/register').send({ regNo: student.regNo, email, password: 'A-Genuinely-Strong-Pass-1' }).expect(200);
      expect(res.body.user).toMatchObject({ email, userType: 'STUDENT', roles: ['STUDENT'] });
      const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
      const me = await h.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.student).toMatchObject({ regNo: student.regNo });
    });

    it('rejects a registration number with no matching student record', async () => {
      const res = await h.http().post('/api/v1/auth/register').send({ regNo: 'NO-SUCH-REGNO', email: uniqueEmail('ghost'), password: 'A-Genuinely-Strong-Pass-1' }).expect(400);
      expect(res.body.code).toBe('REGISTRATION_FAILED');
    });

    it('refuses to create a second account for a student who already has one', async () => {
      const student = await makeStudent(h.prisma);
      const firstEmail = uniqueEmail('first');
      await h.http().post('/api/v1/auth/register').send({ regNo: student.regNo, email: firstEmail, password: 'A-Genuinely-Strong-Pass-1' }).expect(200);
      const res = await h.http().post('/api/v1/auth/register').send({ regNo: student.regNo, email: uniqueEmail('second'), password: 'A-Genuinely-Strong-Pass-1' }).expect(409);
      expect(res.body.code).toBe('ACCOUNT_EXISTS');
    });

    it('rejects an email that does not match the one Registry already has on file', async () => {
      const student = await makeStudent(h.prisma);
      await h.prisma.student.update({ where: { id: student.id }, data: { email: 'on-file@kiu-demo.test' } });
      const res = await h.http().post('/api/v1/auth/register').send({ regNo: student.regNo, email: uniqueEmail('mismatch'), password: 'A-Genuinely-Strong-Pass-1' }).expect(400);
      expect(res.body.code).toBe('REGISTRATION_FAILED');
    });

    it('enforces the password policy', async () => {
      const student = await makeStudent(h.prisma);
      const res = await h.http().post('/api/v1/auth/register').send({ regNo: student.regNo, email: uniqueEmail('weak'), password: 'aaaaaaaaaaaa' }).expect(400);
      expect(res.body.code).toBe('WEAK_PASSWORD');
    });
  });

  describe('rate limiting', () => {
    it('throttles credential endpoints per IP', async () => {
      const limited = await startHarness({ THROTTLE_LOGIN_LIMIT: '3' });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) {
          codes.push((await limited.http().post('/api/v1/auth/login').send({ email: uniqueEmail('rl'), password: TEST_PASSWORD })).status);
        }
        expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
        expect(codes.slice(3)).toEqual([429, 429]);
        expect((await limited.http().get('/api/v1/health')).status).toBe(200); // other routes unaffected
      } finally {
        await limited.close();
      }
    });
  });
});
