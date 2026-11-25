import { randomBytes } from 'node:crypto';
import { ReaderClient, SimWallet } from '@kiu/simulator';
import { VirtualCard, deriveCardKey } from '@kiu/vcard';
import { Harness, startHarness } from './harness';
import { ReaderCreds, adminToken, apiFor, makeExam, makeStudentUser, provisionReader, staffToken } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('virtual AES card tap over the real API (e2e)', () => {
  let h: Harness;
  let admin: string;
  let officer: string;
  let gateCreds: ReaderCreds, examCreds: ReaderCreds;
  let gate: ReaderClient, examReader: ReaderClient;
  const api = () => apiFor(h);

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'CARD_OFFICER');
    gateCreds = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    examCreds = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    gate = new ReaderClient(api(), gateCreds);
    examReader = new ReaderClient(api(), examCreds);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  async function wallet(spec: Parameters<typeof makeStudentUser>[1] = {}) {
    const u = await makeStudentUser(h, spec);
    const i = await api().call('POST', '/cards', { regNo: u.student.regNo }, officer);
    const w = await SimWallet.activate(api(), u.token, i.body.activationCode, i.body.card.cardNumber, i.body.card.id);
    return { u, w, cardId: i.body.card.id as string };
  }
  const alerts = (kind: string, cardId: string) => h.prisma.securityAlert.count({ where: { kind, cardId } });

  it('authenticates mutually, reads the card number under session keys, and is granted', async () => {
    const { w, u } = await wallet();
    const t = await w.tap(gate);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.events.map((e) => e.step)).toEqual(['SELECT AID', 'REQUEST CHALLENGE', 'MUTUAL AUTH (card proof)', 'MUTUAL AUTH (reader proof)', 'READ CARD NUMBER']);
    expect(JSON.stringify(t.events)).not.toContain(w.aesKeyHex); // protocol console never shows key material
    const res = await gate.verify(t.credential);
    expect(res.body).toMatchObject({ decision: 'GRANT', reason_code: 'OK', student: { reg_no: u.student.regNo } });
    const log = await h.prisma.accessLog.findUniqueOrThrow({ where: { id: res.body.log_id } });
    expect(log.authMethod).toBe('VIRTUAL_TAP');
  });

  it('TC-10: a cloned card (copied UID, wrong key) fails mutual authentication; it is logged and alerted', async () => {
    const { w, cardId } = await wallet();
    const clone = new VirtualCard(w.card.uidHex, randomBytes(16), w.cardNumber);
    const before = await alerts('COPIED_UID_WRONG_KEY', cardId);
    const t = await w.tap(gate, clone);
    expect(t).toMatchObject({ ok: false, stage: 'auth' });
    expect(await alerts('COPIED_UID_WRONG_KEY', cardId)).toBe(before + 1);
    const log = await h.prisma.accessLog.findFirstOrThrow({ where: { cardId, reasonCode: 'CREDENTIAL_INVALID', authMethod: 'VIRTUAL_TAP' }, orderBy: { occurredAt: 'desc' } });
    expect(log.decision).toBe('DENY');
  });

  it('gives each session exactly one authentication attempt (no oracle for guessing the proof)', async () => {
    const { w } = await wallet();
    const begin = await gate.post('/access/tap/begin', { uidHex: w.card.uidHex });
    const good = w.card.authenticate(begin.body.rndR);
    const bad = await gate.post('/access/tap/auth', { sessionId: begin.body.sessionId, rndCHex: good.rndCHex, proofHex: '00'.repeat(16) });
    expect(bad.body.ok).toBe(false);
    const retry = await gate.post('/access/tap/auth', { sessionId: begin.body.sessionId, rndCHex: good.rndCHex, proofHex: good.proofHex }); // correct proof, too late
    expect(retry.body.ok).toBe(false);
  });

  it('answers identically for unknown UIDs (no UID enumeration) and then fails authentication', async () => {
    const fake = randomBytes(7).toString('hex').toUpperCase();
    const begin = await gate.post('/access/tap/begin', { uidHex: fake });
    expect(begin.status).toBe(200);
    expect(begin.body.rndR).toMatch(/^[0-9a-f]{32}$/);
    const attacker = new VirtualCard(fake, randomBytes(16), 'KIUFAKE');
    const r = attacker.authenticate(begin.body.rndR);
    const auth = await gate.post('/access/tap/auth', { sessionId: begin.body.sessionId, rndCHex: r.rndCHex, proofHex: r.proofHex });
    expect(auth.body).toMatchObject({ ok: false, reason_code: 'CREDENTIAL_INVALID' });
  });

  it('rejects malformed tap input and sessions used from another reader or after expiry', async () => {
    const { w } = await wallet();
    expect((await gate.post('/access/tap/begin', { uidHex: 'nothex' })).status).toBe(400);
    expect((await gate.post('/access/tap/auth', { sessionId: 'x', rndCHex: 'y', proofHex: 'z' })).status).toBe(400);

    const begin = await gate.post('/access/tap/begin', { uidHex: w.card.uidHex });
    const r = w.card.authenticate(begin.body.rndR);
    const other = await examReader.post('/access/tap/auth', { sessionId: begin.body.sessionId, rndCHex: r.rndCHex, proofHex: r.proofHex });
    expect(other.body.ok).toBe(false); // session is bound to the reader that began it

    const b2 = await gate.post('/access/tap/begin', { uidHex: w.card.uidHex });
    await h.prisma.tapSession.update({ where: { id: b2.body.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r2 = w.card.authenticate(b2.body.rndR);
    expect((await gate.post('/access/tap/auth', { sessionId: b2.body.sessionId, rndCHex: r2.rndCHex, proofHex: r2.proofHex })).body.ok).toBe(false);
  });

  it('rejects tampered protected reads and a read submitted for an unauthenticated session', async () => {
    const { w, cardId } = await wallet();
    const t = await w.tap(gate);
    if (!t.ok) throw new Error('setup');
    const c = t.credential as { sessionId: string; ivHex: string; ctHex: string; macHex: string };
    const flipped = { ...c, ctHex: (parseInt(c.ctHex.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + c.ctHex.slice(2) };
    const res = await gate.verify(flipped);
    expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CREDENTIAL_INVALID' });
    expect(await alerts('TAP_BAD_READ', cardId)).toBe(1);
    // the session was consumed by the failed attempt, so the genuine frame cannot be retried either
    expect((await gate.verify(c)).body.reason_code).toBe('NONCE_REPLAY');

    const begin = await gate.post('/access/tap/begin', { uidHex: w.card.uidHex }); // begun, never authenticated
    const skip = await gate.verify({ type: 'TAP', sessionId: begin.body.sessionId, ivHex: c.ivHex, ctHex: c.ctHex, macHex: c.macHex });
    expect(skip.body).toMatchObject({ decision: 'DENY', reason_code: 'CREDENTIAL_INVALID' });
  });

  it('a read made in one session cannot be replayed into another', async () => {
    const { w } = await wallet();
    const first = await w.tap(gate);
    const second = await w.tap(gate);
    if (!first.ok || !second.ok) throw new Error('setup');
    const spliced = { ...(first.credential as object), sessionId: (second.credential as { sessionId: string }).sessionId };
    expect((await gate.verify(spliced)).body.reason_code).toBe('CREDENTIAL_INVALID');
  });

  it('the card counter is shared with QR: reading via TAP then a stale QR is a clone signal', async () => {
    const { w } = await wallet();
    const qr1 = w.qr();                                    // counter 1
    const t = await w.tap(gate);                           // counter 2
    if (!t.ok) throw new Error('setup');
    expect((await gate.verify(t.credential)).body.decision).toBe('GRANT');
    expect((await gate.verify({ type: 'QR', token: qr1 })).body.reason_code).toBe('COUNTER_INVALID'); // older than the last accepted use
    expect((await gate.verify({ type: 'QR', token: w.qr() })).body.decision).toBe('GRANT');           // counter 3
  });

  it('a lost card is denied by the pipeline even though its AES key still authenticates; replacement works (TC-04, demo 6)', async () => {
    const { w, cardId, u } = await wallet();
    await api().call('POST', `/cards/${cardId}/report-lost`, { reason: 'Stolen at the bus park' }, officer);
    const t = await w.tap(gate);
    expect(t.ok).toBe(true); // cryptographically valid...
    if (!t.ok) return;
    const res = await gate.verify(t.credential);
    expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CARD_LOST' }); // ...but revoked
    expect(res.body.student).toBeNull();
    expect(await alerts('LOST_CARD_PRESENTED', cardId)).toBe(1);

    const rep = await api().call('POST', `/cards/${cardId}/replace`, { reason: 'Replacement after theft' }, officer);
    const nw = await SimWallet.activate(api(), u.token, rep.body.activationCode, rep.body.card.cardNumber, rep.body.card.id);
    const nt = await nw.tap(gate);
    expect(nt.ok && (await gate.verify(nt.credential)).body.decision).toBe('GRANT');
  });

  it('the credential type never changes eligibility: QR and TAP get identical decisions from the same rule (exam)', async () => {
    const { courseCode } = await makeExam(h.prisma, 'EXH-A');
    const cases = [
      { name: 'eligible', spec: { enrol: [courseCode] }, reason: 'OK' },
      { name: 'finance', spec: { enrol: [courseCode], examCleared: false, fees: 30 }, reason: 'FINANCE_NOT_CLEARED' },
      { name: 'not enrolled', spec: { enrol: [] as string[] }, reason: 'NOT_ENROLLED' },
      { name: 'unregistered', spec: { enrol: [courseCode], registered: false }, reason: 'NOT_REGISTERED' },
    ];
    for (const c of cases) {
      const viaQr = await wallet(c.spec);
      const viaTap = await wallet(c.spec);
      const qr = await examReader.verify({ type: 'QR', token: viaQr.w.qr() });
      const t = await viaTap.w.tap(examReader);
      if (!t.ok) throw new Error('tap failed for ' + c.name);
      const tap = await examReader.verify(t.credential);
      expect([c.name, qr.body.reason_code]).toEqual([c.name, c.reason]);
      expect([c.name, tap.body.reason_code, tap.body.decision]).toEqual([c.name, qr.body.reason_code, qr.body.decision]);
    }
  });

  it('keys are diversified: two cards never share a key and the master is not derivable from a card key', async () => {
    const a = await wallet();
    const b = await wallet();
    expect(a.w.aesKeyHex).not.toBe(b.w.aesKeyHex);
    const ra = await h.prisma.card.findUniqueOrThrow({ where: { id: a.cardId } });
    expect(deriveCardKey(h.env.CARD_MASTER_KEY, ra.uidHex, ra.aidHex).toString('hex')).toBe(a.w.aesKeyHex);
    expect(h.env.CARD_MASTER_KEY).not.toBe(a.w.aesKeyHex);
  });
});
