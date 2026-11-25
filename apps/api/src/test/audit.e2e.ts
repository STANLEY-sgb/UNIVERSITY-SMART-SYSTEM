import { Harness, startHarness } from './harness';
import { AuditService, redact } from '../modules/audit/audit.service';

describe('audit trail (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let audit: AuditService;
  beforeAll(async () => { h = await startHarness(); audit = h.app.get(AuditService); });
  afterAll(async () => { await h.close(); });

  it('redacts credential-like keys recursively', () => {
    expect(redact({ a: 1, password: 'x', nested: { apiToken: 'y', ok: [{ mfaSecret: 'z', fine: 1 }] } })).toEqual({
      a: 1, password: '[REDACTED]', nested: { apiToken: '[REDACTED]', ok: [{ mfaSecret: '[REDACTED]', fine: 1 }] },
    });
  });

  it('appends hash-linked entries and verifies the chain', async () => {
    const a = await audit.record({ action: 'test.one', entityType: 'Test', entityId: 'a', after: { x: 1 } });
    const b = await audit.record({ action: 'test.two', entityType: 'Test', entityId: 'b', before: { x: 1 }, after: { x: 2 }, reason: 'because' });
    expect(b.seq > a.seq).toBe(true);
    const rows = await h.prisma.auditTrail.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { seq: 'asc' } });
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(await audit.verifyChain()).toMatchObject({ ok: true, brokenAtSeq: null });
  });

  it('keeps one linear chain under concurrent writers (advisory lock)', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit.record({ action: 'test.concurrent', entityType: 'Test', entityId: String(i) })));
    const res = await audit.verifyChain();
    expect(res.ok).toBe(true);
    const rows = await h.prisma.auditTrail.findMany({ select: { prevHash: true } });
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(rows.length); // no two entries share a parent
  });

  it('rolls the audit entry back together with a failed business transaction', async () => {
    const before = await h.prisma.auditTrail.count({ where: { action: 'test.rollback' } });
    await expect(h.prisma.$transaction(async (tx) => {
      await audit.record({ action: 'test.rollback', entityType: 'Test' }, tx);
      throw new Error('business failure');
    })).rejects.toThrow('business failure');
    expect(await h.prisma.auditTrail.count({ where: { action: 'test.rollback' } })).toBe(before);
  });

  it('is append-only at the database level (UPDATE, DELETE, TRUNCATE are rejected)', async () => {
    const { id } = await audit.record({ action: 'test.immutable', entityType: 'Test' });
    await expect(h.prisma.$executeRaw`UPDATE audit_trail SET action = 'edited' WHERE id = ${id}::uuid`).rejects.toThrow(/append-only/);
    await expect(h.prisma.$executeRaw`DELETE FROM audit_trail WHERE id = ${id}::uuid`).rejects.toThrow(/append-only/);
    await expect(h.prisma.$executeRawUnsafe('TRUNCATE audit_trail')).rejects.toThrow(/append-only/);
    await expect(h.prisma.auditTrail.update({ where: { id }, data: { reason: 'x' } })).rejects.toThrow();
    expect((await h.prisma.auditTrail.findUniqueOrThrow({ where: { id } })).action).toBe('test.immutable');
  });

  it('detects tampering by a privileged actor who bypasses the trigger', async () => {
    const { id, seq } = await audit.record({ action: 'test.tamper', entityType: 'Test', after: { amount: 10 } });
    await audit.record({ action: 'test.after-tamper', entityType: 'Test' });
    expect((await audit.verifyChain()).ok).toBe(true);

    // Simulate a DBA disabling the trigger and rewriting history.
    await h.prisma.$executeRawUnsafe('ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_update_delete');
    try {
      await h.prisma.$executeRaw`UPDATE audit_trail SET after = '{"amount": 9999}'::jsonb WHERE id = ${id}::uuid`;
      const res = await audit.verifyChain();
      expect(res.ok).toBe(false);
      expect(res.brokenAtSeq).toBe(seq.toString());
    } finally {
      await h.prisma.$executeRaw`UPDATE audit_trail SET after = '{"amount": 10}'::jsonb WHERE id = ${id}::uuid`;
      await h.prisma.$executeRawUnsafe('ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_update_delete');
    }
    expect((await audit.verifyChain()).ok).toBe(true);
  });
});
