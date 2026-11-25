import { generateQrKeyPair, signMessage } from '@kiu/vcard';
import { SimWallet } from '@kiu/simulator';
import { Harness, startHarness } from './harness';
import { ReaderCreds, adminToken, apiFor, makeStudent, makeStudentUser, provisionReader, staffToken, verify } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('card issuance, activation and lifecycle (e2e)', () => {
  let h: Harness;
  let officer: string;
  let gate: ReaderCreds;
  const api = () => apiFor(h);
  const call = (m: string, p: string, body?: unknown, t = officer) => api().call(m, p, body, t);

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    officer = await staffToken(h, 'CARD_OFFICER');
    gate = await provisionReader(h, await adminToken(h), 'GATE', 'GATE-MAIN');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const issue = async (regNo: string) => {
    const r = await call('POST', '/cards', { regNo });
    expect(r.status).toBe(201);
    return r.body as { card: { id: string; cardNumber: string; status: string }; activationCode: string };
  };
  const activate = (u: { token: string }, i: Awaited<ReturnType<typeof issue>>) => SimWallet.activate(api(), u.token, i.activationCode, i.card.cardNumber, i.card.id);

  it('issues a PENDING card with a one-time code; only a hash of the code is stored; no secrets are exposed', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    expect(i.card.status).toBe('PENDING');
    expect(i.activationCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const row = await h.prisma.card.findUniqueOrThrow({ where: { id: i.card.id }, include: { credentials: true } });
    expect(row.activationHash).not.toBeNull();
    expect(row.activationHash).not.toContain(i.activationCode.replace(/-/g, ''));
    expect(row.uidHex).toMatch(/^[0-9A-F]{14}$/);
    expect(row.aidHex).toBe('4B4955');
    expect(row.credentials.map((c) => c.kind)).toEqual(['AES_CARD_KEY']);
    expect(row.credentials[0]!.secretEnc).toBeNull(); // the key is derived from the master key, never stored
    const listing = await call('GET', `/cards?regNo=${u.student.regNo}`);
    expect(JSON.stringify(listing.body)).not.toMatch(/uidHex|activationHash|regNoHash|secret|aesKey/i);
  });

  it('requires cards.issue; students and other staff cannot issue', async () => {
    const u = await makeStudentUser(h);
    expect((await call('POST', '/cards', { regNo: u.student.regNo }, u.token)).status).toBe(403);
    expect((await call('POST', '/cards', { regNo: u.student.regNo }, await staffToken(h, 'LIBRARIAN'))).status).toBe(403);
    expect((await call('GET', '/cards', undefined, u.token)).status).toBe(403);
  });

  it('refuses to issue to unknown or non-active students', async () => {
    expect((await call('POST', '/cards', { regNo: 'NOPE-0000' })).status).toBe(404);
    const s = await makeStudent(h.prisma, { active: false });
    const r = await call('POST', '/cards', { regNo: s.regNo });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STUDENT_NOT_ACTIVE');
  });

  it('activation: device key proof of possession, then the card works end to end', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    const w = await activate(u, i);
    expect(w.aesKeyHex).toMatch(/^[0-9a-f]{32}$/);
    const card = await h.prisma.card.findUniqueOrThrow({ where: { id: i.card.id }, include: { credentials: true } });
    expect(card).toMatchObject({ status: 'ACTIVE', activationHash: null });
    expect(card.activatedAt).not.toBeNull();
    const qr = card.credentials.find((c) => c.kind === 'ED25519_QR')!;
    expect(qr.publicKeyHex).toBe(w.devicePublicKeyHex);
    expect(JSON.stringify(card, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(w.aesKeyHex); // server holds no per-card secret
    expect((await verify(h, gate, w.qr()).expect(200)).body.decision).toBe('GRANT');
  });

  it('activation codes are single-use', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    await activate(u, i);
    const again = await call('POST', '/me/card/activate', { code: i.activationCode, devicePublicKeyHex: generateQrKeyPair().publicKeyHex, proofHex: '0'.repeat(128) }, u.token);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('ACTIVATION_INVALID');
  });

  it('rejects a wrong code, another student\'s code, an expired code, and a device that cannot prove key possession', async () => {
    const a = await makeStudentUser(h);
    const b = await makeStudentUser(h);
    const i = await issue(a.student.regNo);
    const keys = generateQrKeyPair();
    const body = (code: string, proofKey = keys.privateKeyHex) => ({ code, devicePublicKeyHex: keys.publicKeyHex, proofHex: signMessage(proofKey, `KIU-ACTIVATE:${i.card.cardNumber}`) });

    expect((await call('POST', '/me/card/activate', body('AAAA-BBBB-CCCC'), a.token)).body.code).toBe('ACTIVATION_INVALID');
    expect((await call('POST', '/me/card/activate', body(i.activationCode), b.token)).body.code).toBe('ACTIVATION_INVALID'); // stolen code
    const pop = await call('POST', '/me/card/activate', body(i.activationCode, generateQrKeyPair().privateKeyHex), a.token);
    expect(pop.body.code).toBe('PROOF_OF_POSSESSION_FAILED');
    expect((await call('POST', '/me/card/activate', { ...body(i.activationCode), devicePublicKeyHex: 'abcd' }, a.token)).status).toBe(400);

    await h.prisma.card.update({ where: { id: i.card.id }, data: { activationExpiresAt: new Date(Date.now() - 1000) } });
    expect((await call('POST', '/me/card/activate', body(i.activationCode), a.token)).body.code).toBe('ACTIVATION_INVALID');
    expect((await h.prisma.card.findUniqueOrThrow({ where: { id: i.card.id } })).status).toBe('PENDING'); // nothing leaked through
  });

  it('only one of several concurrent activations of the same code succeeds', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => activate(u, i)));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(await h.prisma.cardCredential.count({ where: { cardId: i.card.id, kind: 'ED25519_QR', status: 'ACTIVE' } })).toBe(1);
  });

  it('enforces one ACTIVE card per student (issue is refused; a second activation cannot slip through)', async () => {
    const u = await makeStudentUser(h);
    const first = await issue(u.student.regNo);
    await activate(u, first);
    const dup = await call('POST', '/cards', { regNo: u.student.regNo });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_HAS_ACTIVE_CARD');
    expect(await h.prisma.card.count({ where: { studentId: u.student.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('a card reported lost before it was ever activated can still be retired', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    const r = await call('POST', `/cards/${i.card.id}/report-lost`, { reason: 'Never collected, lost in post' });
    expect(r.body.status).toBe('LOST');
    const dead = await call('POST', '/me/card/activate', { code: i.activationCode, devicePublicKeyHex: generateQrKeyPair().publicKeyHex, proofHex: '0'.repeat(128) }, u.token);
    expect(dead.body.code).toBe('ACTIVATION_INVALID'); // the code died with the card
  });

  it('a new request supersedes an unactivated card', async () => {
    const u = await makeStudentUser(h);
    const a = await issue(u.student.regNo);
    const b = await issue(u.student.regNo);
    expect((await h.prisma.card.findUniqueOrThrow({ where: { id: a.card.id } })).status).toBe('EXPIRED');
    const old = await call('POST', '/me/card/activate', { code: a.activationCode, devicePublicKeyHex: generateQrKeyPair().publicKeyHex, proofHex: '0'.repeat(128) }, u.token);
    expect(old.body.code).toBe('ACTIVATION_INVALID');
    expect(b.card.status).toBe('PENDING');
  });

  describe('block / unblock / lost', () => {
    it('blocking denies at readers and unblocking restores access; both are audited and pushed as revocation versions', async () => {
      const u = await makeStudentUser(h);
      const i = await issue(u.student.regNo);
      const w = await activate(u, i);
      expect((await call('POST', `/cards/${i.card.id}/block`, { reason: 'x' })).status).toBe(400); // reason too short
      expect((await call('POST', `/cards/${i.card.id}/block`, { reason: 'Suspected misuse' })).body.status).toBe('BLOCKED');
      expect((await verify(h, gate, w.qr()).expect(200)).body.reason_code).toBe('CARD_BLOCKED');
      expect((await call('POST', `/cards/${i.card.id}/block`, { reason: 'Already blocked' })).status).toBe(409);

      const un = await call('PATCH', `/cards/${i.card.id}`, { status: 'ACTIVE', reason: 'Cleared by security' });
      expect(un.body.status).toBe('ACTIVE');
      expect((await verify(h, gate, w.qr()).expect(200)).body.decision).toBe('GRANT');

      const history = await call('GET', `/cards/${i.card.id}/history`);
      expect(history.body.map((e: { eventType: string }) => e.eventType)).toEqual(['ISSUED', 'ACTIVATED', 'BLOCKED', 'UNBLOCKED']);
      expect(await h.prisma.cardRevocation.count({ where: { cardId: i.card.id } })).toBe(2);
      expect(await h.prisma.auditTrail.count({ where: { entityId: i.card.id, action: { in: ['cards.block', 'cards.unblock', 'cards.issue', 'cards.activated'] } } })).toBe(4);
      expect(await h.prisma.notification.count({ where: { studentId: u.student.id, kind: 'CARD_BLOCKED' } })).toBe(1);
    });

    it('LOST is final: revokes credentials, can never be unblocked, and the old wallet is denied', async () => {
      const u = await makeStudentUser(h);
      const i = await issue(u.student.regNo);
      const w = await activate(u, i);
      const lost = await call('POST', `/cards/${i.card.id}/report-lost`, { reason: 'Phone stolen' });
      expect(lost.body.status).toBe('LOST');
      expect(await h.prisma.cardCredential.count({ where: { cardId: i.card.id, status: 'ACTIVE' } })).toBe(0);
      expect((await verify(h, gate, w.qr()).expect(200)).body.reason_code).toBe('CARD_LOST');
      const un = await call('POST', `/cards/${i.card.id}/unblock`, { reason: 'Found it again' });
      expect(un.status).toBe(409);
      expect(un.body.code).toBe('LOST_CARD_FINAL');
      expect((await call('PATCH', `/cards/${i.card.id}`, { status: 'ACTIVE', reason: 'Found it again' })).status).toBe(409);
      expect((await call('POST', `/cards/${i.card.id}/report-lost`, { reason: 'Phone stolen' })).status).toBe(200); // idempotent
      expect(await h.prisma.cardRevocation.count({ where: { cardId: i.card.id } })).toBe(1);
    });

    it('a student can report their own card lost, and only their own', async () => {
      const a = await makeStudentUser(h);
      const b = await makeStudentUser(h);
      const ia = await issue(a.student.regNo);
      const wa = await activate(a, ia);
      const ib = await issue(b.student.regNo);
      await activate(b, ib);
      const r = await call('POST', '/me/card/report-lost', { reason: 'Lost my phone on a bus' }, a.token);
      expect(r.body.status).toBe('LOST');
      expect((await verify(h, gate, wa.qr()).expect(200)).body.reason_code).toBe('CARD_LOST');
      expect((await h.prisma.card.findUniqueOrThrow({ where: { id: ib.card.id } })).status).toBe('ACTIVE'); // untouched
      expect((await call('POST', '/me/card/report-lost', { reason: 'Lost my phone on a bus' }, a.token)).status).toBe(404); // nothing left to report
    });
  });

  describe('replacement (demo 6)', () => {
    it('retires the old card, issues fresh identifiers/keys, keeps entitlements, and only the new card works', async () => {
      const u = await makeStudentUser(h, { meal: true });
      const i = await issue(u.student.regNo);
      const oldWallet = await activate(u, i);
      expect((await verify(h, gate, oldWallet.qr()).expect(200)).body.decision).toBe('GRANT');

      const rep = await call('POST', `/cards/${i.card.id}/replace`, { reason: 'Phone lost on campus', feeStatus: 'WAIVED' });
      expect(rep.status).toBe(201);
      const oldRow = await h.prisma.card.findUniqueOrThrow({ where: { id: i.card.id } });
      const newRow = await h.prisma.card.findUniqueOrThrow({ where: { id: rep.body.card.id } });
      expect(oldRow.status).toBe('LOST');
      expect(newRow).toMatchObject({ status: 'PENDING', studentId: u.student.id, replacesCardId: i.card.id });
      expect(newRow.cardNumber).not.toBe(oldRow.cardNumber);
      expect(newRow.uidHex).not.toBe(oldRow.uidHex);

      const newWallet = await SimWallet.activate(api(), u.token, rep.body.activationCode, rep.body.card.cardNumber, rep.body.card.id);
      expect(newWallet.devicePublicKeyHex).not.toBe(oldWallet.devicePublicKeyHex);
      expect(newWallet.aesKeyHex).not.toBe(oldWallet.aesKeyHex);

      expect((await verify(h, gate, oldWallet.qr()).expect(200)).body.reason_code).toBe('CARD_LOST');
      const ok = await verify(h, gate, newWallet.qr()).expect(200);
      expect(ok.body).toMatchObject({ decision: 'GRANT', student: { reg_no: u.student.regNo } }); // same student, entitlements intact
      expect(await h.prisma.accessLog.count({ where: { cardId: i.card.id } })).toBeGreaterThan(0); // history preserved

      const events = (await call('GET', `/cards/${i.card.id}/history`)).body.map((e: { eventType: string }) => e.eventType);
      expect(events).toEqual(expect.arrayContaining(['ISSUED', 'ACTIVATED', 'LOST', 'REPLACED']));
      expect((await call('POST', `/cards/${i.card.id}/replace`, { reason: 'Again please' })).body.code).toBe('ALREADY_REPLACED');
      expect(await h.prisma.card.count({ where: { studentId: u.student.id, status: 'ACTIVE' } })).toBe(1);
    });

    it('requires cards.replace', async () => {
      const u = await makeStudentUser(h);
      const i = await issue(u.student.regNo);
      expect((await call('POST', `/cards/${i.card.id}/replace`, { reason: 'Not allowed' }, await staffToken(h, 'SECURITY_OFFICER'))).status).toBe(403);
    });
  });

  it('re-enrolment on a new phone revokes the previous device key', async () => {
    const u = await makeStudentUser(h);
    const i = await issue(u.student.regNo);
    const phoneA = await activate(u, i);
    const reset = await call('POST', `/cards/${i.card.id}/reset-activation`);
    expect(reset.status).toBe(200);
    const phoneB = await SimWallet.activate(api(), u.token, reset.body.activationCode, i.card.cardNumber, i.card.id);
    expect((await verify(h, gate, phoneA.qr()).expect(200)).body.decision).toBe('DENY'); // old device key revoked
    expect((await verify(h, gate, phoneB.qr()).expect(200)).body.decision).toBe('GRANT');
  });

  it('GET /me/card shows the student only their own card state', async () => {
    const a = await makeStudentUser(h);
    const i = await issue(a.student.regNo);
    await activate(a, i);
    const mine = await call('GET', '/me/card', undefined, a.token);
    expect(mine.body.current).toMatchObject({ cardNumber: i.card.cardNumber, status: 'ACTIVE' });
    expect(JSON.stringify(mine.body)).not.toMatch(/uidHex|activationHash|key/i);
    const b = await makeStudentUser(h);
    expect((await call('GET', '/me/card', undefined, b.token)).body.current).toBeNull();
  });
});
