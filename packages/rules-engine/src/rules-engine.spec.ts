import { evaluate, validateRule, RuleDefinition, FACT_UNKNOWN } from './index';

const leaf = (fact: string, op: string, value: unknown, reason = 'RULE_NOT_MET', message = `${fact} ${op} failed`, extra: object = {}) =>
  ({ fact, op, value, reason, message, ...extra });
const rule = (requirements: unknown): RuleDefinition => {
  const v = validateRule({ schemaVersion: 1, requirements });
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.definition!;
};
const run = (req: unknown, facts: Record<string, unknown>, ctx: Record<string, unknown> = {}) => evaluate(rule(req), facts, ctx);

describe('operators (table-driven)', () => {
  // [op, actual, expected, shouldPass]
  const cases: [string, unknown, unknown, boolean][] = [
    ['eq', 5, 5, true], ['eq', 5, 6, false], ['eq', 'a', 'a', true], ['eq', true, true, true], ['eq', true, false, false],
    ['neq', 5, 6, true], ['neq', 5, 5, false], ['neq', 'ACTIVE', 'LOST', true],
    ['gt', 6, 5, true], ['gt', 5, 5, false], ['gt', 4, 5, false],
    ['gte', 5, 5, true], ['gte', 4, 5, false], ['gte', 100, 100, true],
    ['lt', 4, 5, true], ['lt', 5, 5, false], ['lt', 6, 5, false],
    ['lte', 5, 5, true], ['lte', 6, 5, false], ['lte', 0, 0, true],
    ['contains', ['CSC1101', 'CSC2201'], 'CSC1101', true], ['contains', ['CSC1101'], 'LAW1101', false],
    ['contains', 'hello world', 'world', true], ['contains', 'hello', 'xyz', false], ['contains', 42, 4, false],
    ['between', 5, [1, 10], true], ['between', 1, [1, 10], true], ['between', 10, [1, 10], true], ['between', 11, [1, 10], false], ['between', 0, [1, 10], false],
    ['in', 'GATE', ['GATE', 'LAB'], true], ['in', 'EXAM', ['GATE', 'LAB'], false], ['in', 3, [1, 2, 3], true],
    ['gt', 'b', 'a', true], ['gt', 5, 'a', false], // mixed types never order
  ];
  it.each(cases)('%s(%j, %j) -> %s', (op, actual, expected, pass) => {
    expect(run(leaf('x', op, expected), { x: actual }).allowed).toBe(pass);
  });
});

describe('decision content', () => {
  it('returns the reason code and message of the first unmet criterion', () => {
    const r = run({ all: [
      leaf('semester_registered', 'eq', true, 'NOT_REGISTERED', 'Register for the semester first.'),
      leaf('fees_paid_percent', 'gte', 60, 'FINANCE_NOT_CLEARED', 'Clear fees at the Finance office.'),
    ] }, { semester_registered: true, fees_paid_percent: 40 });
    expect(r.allowed).toBe(false);
    expect(r.failure).toMatchObject({ reason: 'FINANCE_NOT_CLEARED', message: 'Clear fees at the Finance office.', fact: 'fees_paid_percent' });
  });

  it('reports the FIRST failing criterion when several fail', () => {
    const r = run({ all: [leaf('a', 'eq', 1, 'A_FAIL'), leaf('b', 'eq', 1, 'B_FAIL')] }, { a: 0, b: 0 });
    expect(r.failure?.reason).toBe('A_FAIL');
  });

  it('short-circuits after the first failure but traces what ran', () => {
    const r = run({ all: [leaf('a', 'eq', 1), leaf('b', 'eq', 1)] }, { a: 0, b: 1 });
    expect(r.trace).toHaveLength(1);
  });

  it('allows when every criterion holds', () => {
    const r = run({ all: [leaf('a', 'eq', 1), leaf('b', 'gte', 2)] }, { a: 1, b: 2 });
    expect(r).toMatchObject({ allowed: true, failure: null });
    expect(r.trace.every((t) => t.passed)).toBe(true);
  });
});

describe('boolean composition', () => {
  const A = (ok: boolean) => leaf('a', 'eq', ok ? 1 : 2, 'A', 'a failed');
  const B = (ok: boolean) => leaf('b', 'eq', ok ? 1 : 2, 'B', 'b failed');
  const facts = { a: 1, b: 1 };

  it.each([[true, true, true], [true, false, false], [false, true, false], [false, false, false]])('all(%s,%s)=%s', (x, y, out) => {
    expect(run({ all: [A(x), B(y)] }, facts).allowed).toBe(out);
  });
  it.each([[true, true, true], [true, false, true], [false, true, true], [false, false, false]])('any(%s,%s)=%s', (x, y, out) => {
    expect(run({ any: [A(x), B(y)] }, facts).allowed).toBe(out);
  });
  it('any() with no match reports the first branch failure, or a custom message', () => {
    expect(run({ any: [A(false), B(false)] }, facts).failure?.reason).toBe('A');
    const r = run({ any: [A(false), B(false)], reason: 'NEITHER', message: 'Need a or b' }, facts);
    expect(r.failure).toMatchObject({ reason: 'NEITHER', message: 'Need a or b' });
  });
  it('supports not()', () => {
    expect(run({ not: leaf('status', 'eq', 'LOST'), reason: 'CARD_LOST', message: 'Card is lost' }, { status: 'ACTIVE' }).allowed).toBe(true);
    const bad = run({ not: leaf('status', 'eq', 'LOST'), reason: 'CARD_LOST', message: 'Card is lost' }, { status: 'LOST' });
    expect(bad.failure?.reason).toBe('CARD_LOST');
  });
  it('supports deep nesting (all > any > all)', () => {
    const req = { all: [A(true), { any: [B(false), { all: [A(true), B(true)] }] }] };
    expect(run(req, facts).allowed).toBe(true);
  });
});

describe('context and fact references', () => {
  it('compares a fact against a context value', () => {
    const req = leaf('exam_venue', 'eq', { ctx: 'reader_venue' }, 'WRONG_VENUE', 'Wrong examination room');
    expect(run(req, { exam_venue: 'EXH-A' }, { reader_venue: 'EXH-A' }).allowed).toBe(true);
    expect(run(req, { exam_venue: 'EXH-A' }, { reader_venue: 'EXH-B' }).failure?.reason).toBe('WRONG_VENUE');
  });
  it('reads the left side from context with the ctx. prefix', () => {
    expect(run(leaf('ctx.service', 'eq', 'GATE'), {}, { service: 'GATE' }).allowed).toBe(true);
  });
  it('compares two facts', () => {
    const req = leaf('paid', 'gte', { fact: 'required' });
    expect(run(req, { paid: 50, required: 50 }).allowed).toBe(true);
    expect(run(req, { paid: 49, required: 50 }).allowed).toBe(false);
  });
  it('checks membership of a context value in a fact array (enrolled course units)', () => {
    const req = leaf('enrolled_course_units', 'contains', { ctx: 'course_unit' }, 'NOT_ENROLLED', 'Not enrolled in this course unit');
    expect(run(req, { enrolled_course_units: ['CSC1101', 'CSC2201'] }, { course_unit: 'CSC1101' }).allowed).toBe(true);
    expect(run(req, { enrolled_course_units: ['CSC1101'] }, { course_unit: 'LAW1101' }).failure?.reason).toBe('NOT_ENROLLED');
  });
  it('resolves nested paths', () => {
    expect(run(leaf('hostel.id', 'eq', 'HA'), { hostel: { id: 'HA' } }).allowed).toBe(true);
  });
});

describe('date/time windows', () => {
  const window = { all: [
    leaf('ctx.now', 'gte', { ctx: 'window_start' }, 'OUTSIDE_TIME_WINDOW', 'Too early', { type: 'datetime' }),
    leaf('ctx.now', 'lte', { ctx: 'window_end' }, 'OUTSIDE_TIME_WINDOW', 'Too late', { type: 'datetime' }),
  ] };
  const ctx = (now: string) => ({ now, window_start: '2026-11-14T08:30:00Z', window_end: '2026-11-14T10:00:00Z' });
  it('allows inside the window', () => expect(run(window, {}, ctx('2026-11-14T09:00:00Z')).allowed).toBe(true));
  it('denies before', () => expect(run(window, {}, ctx('2026-11-14T08:00:00Z')).failure?.message).toBe('Too early'));
  it('denies after', () => expect(run(window, {}, ctx('2026-11-14T10:00:01Z')).failure?.message).toBe('Too late'));
  it('compares instants across timezone offsets', () => {
    expect(run(window, {}, ctx('2026-11-14T12:00:00+03:00')).allowed).toBe(true); // 09:00Z
  });
  it('fails closed on unparseable dates', () => expect(run(window, {}, ctx('not-a-date')).allowed).toBe(false));
  it('supports between on datetimes', () => {
    const req = leaf('ctx.now', 'between', ['2026-11-14T08:00:00Z', '2026-11-14T09:00:00Z'], 'OUTSIDE_TIME_WINDOW', 'x', { type: 'datetime' });
    expect(run(req, {}, { now: '2026-11-14T08:30:00Z' }).allowed).toBe(true);
  });
});

describe('fail-closed behaviour', () => {
  it.each([
    ['missing fact', {}],
    ['null fact', { x: null }],
    ['undefined fact', { x: undefined }],
  ])('%s denies with FACT_UNKNOWN', (_n, facts) => {
    const r = run(leaf('x', 'eq', 1), facts as Record<string, unknown>);
    expect(r.allowed).toBe(false);
    expect(r.failure?.reason).toBe(FACT_UNKNOWN);
  });
  it('denies when a referenced context value is missing', () => {
    expect(run(leaf('x', 'eq', { ctx: 'nope' }), { x: 1 }).failure?.reason).toBe(FACT_UNKNOWN);
  });
  it('does not let not() turn an unknown fact into a grant', () => {
    const r = run({ not: leaf('status', 'eq', 'LOST'), reason: 'CARD_LOST', message: 'x' }, {});
    expect(r.allowed).toBe(false);
    expect(r.failure?.reason).toBe(FACT_UNKNOWN);
  });
  it('does not let any() hide an unknown fact behind another failing branch', () => {
    expect(run({ any: [leaf('a', 'eq', 1), leaf('b', 'eq', 1)] }, {}).allowed).toBe(false);
  });
  it('treats objects/arrays as non-comparable for ordering', () => {
    expect(run(leaf('x', 'gt', 1), { x: { y: 1 } }).allowed).toBe(false);
  });
  it('is deterministic', () => {
    const req = { all: [leaf('a', 'gte', 3), leaf('b', 'eq', true)] };
    const f = { a: 3, b: true };
    expect(run(req, f)).toEqual(run(req, f));
  });
});

describe('abuse resistance (rules are data, never code)', () => {
  it.each(['__proto__.polluted', 'constructor.name', 'a.prototype.b'])('rejects forbidden path %s at validation', (path) => {
    expect(validateRule({ schemaVersion: 1, requirements: leaf(path, 'eq', 1) }).ok).toBe(false);
  });
  it('does not read inherited properties at evaluation time', () => {
    const facts = JSON.parse('{"a":{}}');
    expect(run(leaf('a.toString', 'eq', 'x'), facts).failure?.reason).toBe(FACT_UNKNOWN);
    expect(run(leaf('hasOwnProperty', 'eq', 'x'), {}).failure?.reason).toBe(FACT_UNKNOWN);
  });
  it('treats string values that look like code as inert text', () => {
    const r = run(leaf('x', 'eq', "process.exit(1); require('fs')"), { x: 'safe' });
    expect(r.allowed).toBe(false);
  });
  it('rejects unknown keys and unknown operators', () => {
    expect(validateRule({ schemaVersion: 1, requirements: { ...leaf('x', 'eq', 1), script: 'alert(1)' } }).ok).toBe(false);
    expect(validateRule({ schemaVersion: 1, requirements: leaf('x', 'matches', '.*') }).ok).toBe(false);
    expect(validateRule({ schemaVersion: 1, requirements: leaf('x', 'eq', { fn: 'x' }) }).ok).toBe(false);
  });
});

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRule({ schemaVersion: 1, requirements: leaf('x', 'eq', 1) }).ok).toBe(true);
  });
  it.each([
    ['wrong schema version', { schemaVersion: 2, requirements: leaf('x', 'eq', 1) }],
    ['missing requirements', { schemaVersion: 1 }],
    ['bad reason code', { schemaVersion: 1, requirements: leaf('x', 'eq', 1, 'lower case') }],
    ['empty message', { schemaVersion: 1, requirements: leaf('x', 'eq', 1, 'OK_CODE', '') }],
    ['between without pair', { schemaVersion: 1, requirements: leaf('x', 'between', [1]) }],
    ['in without array', { schemaVersion: 1, requirements: leaf('x', 'in', 1) }],
    ['array on eq', { schemaVersion: 1, requirements: leaf('x', 'eq', [1, 2]) }],
    ['null ordering', { schemaVersion: 1, requirements: leaf('x', 'gt', null) }],
    ['empty all', { schemaVersion: 1, requirements: { all: [] } }],
    ['bad path', { schemaVersion: 1, requirements: leaf('x y', 'eq', 1) }],
    ['not an object', 'rule'],
  ])('rejects %s', (_n, input) => {
    const v = validateRule(input);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
  it('rejects excessive nesting', () => {
    let node: unknown = leaf('x', 'eq', 1);
    for (let i = 0; i < 9; i++) node = { all: [node] };
    expect(validateRule({ schemaVersion: 1, requirements: node }).errors.join()).toMatch(/nesting/);
  });
  it('rejects excessive size', () => {
    const many = { all: Array.from({ length: 50 }, () => ({ all: [leaf('x', 'eq', 1), leaf('y', 'eq', 1), leaf('z', 'eq', 1)] })) };
    expect(validateRule({ schemaVersion: 1, requirements: many }).errors.join()).toMatch(/more than/);
  });
});

describe('realistic service rules', () => {
  const exam = rule({ all: [
    leaf('account_active', 'eq', true, 'STUDENT_SUSPENDED', 'Student account is not active'),
    leaf('semester_registered', 'eq', true, 'NOT_REGISTERED', 'Not registered for the semester'),
    leaf('exam_cleared', 'eq', true, 'FINANCE_NOT_CLEARED', 'Examination clearance not granted by Finance'),
    leaf('enrolled_course_units', 'contains', { ctx: 'course_unit' }, 'NOT_ENROLLED', 'Not enrolled in this course unit'),
    leaf('ctx.venue_code', 'eq', { ctx: 'exam_venue_code' }, 'WRONG_VENUE', 'Wrong examination room'),
  ] });
  const base = { account_active: true, semester_registered: true, exam_cleared: true, enrolled_course_units: ['CSC1101'] };
  const ctx = { course_unit: 'CSC1101', venue_code: 'EXH-A', exam_venue_code: 'EXH-A' };

  it('TC-01 eligible student in the right room is granted', () => expect(evaluate(exam, base, ctx).allowed).toBe(true));
  it('TC-02 insufficient finance clearance is denied for finance', () =>
    expect(evaluate(exam, { ...base, exam_cleared: false }, ctx).failure?.reason).toBe('FINANCE_NOT_CLEARED'));
  it('TC-03 unregistered course unit is denied', () =>
    expect(evaluate(exam, { ...base, enrolled_course_units: ['LAW1101'] }, ctx).failure?.reason).toBe('NOT_ENROLLED'));
  it('wrong room is denied with the venue reason', () =>
    expect(evaluate(exam, base, { ...ctx, venue_code: 'EXH-B' }).failure?.reason).toBe('WRONG_VENUE'));
  it('same facts => same decision (auth method cannot matter: it is not an input)', () =>
    expect(evaluate(exam, base, ctx)).toEqual(evaluate(exam, { ...base }, { ...ctx })));

  const borrow = rule({ all: [
    leaf('library_overdue_items', 'eq', 0, 'LIBRARY_OVERDUE', 'Return overdue items first'),
    leaf('library_fines_ugx', 'lte', { ctx: 'fine_limit_ugx' }, 'LIBRARY_FINES', 'Outstanding fines exceed the limit'),
  ] });
  it('TC-05 overdue items block borrowing', () =>
    expect(evaluate(borrow, { library_overdue_items: 2, library_fines_ugx: 0 }, { fine_limit_ugx: 5000 }).failure?.reason).toBe('LIBRARY_OVERDUE'));
  it('fine threshold is a configurable context value, not hard-coded', () => {
    expect(evaluate(borrow, { library_overdue_items: 0, library_fines_ugx: 6000 }, { fine_limit_ugx: 5000 }).allowed).toBe(false);
    expect(evaluate(borrow, { library_overdue_items: 0, library_fines_ugx: 6000 }, { fine_limit_ugx: 10000 }).allowed).toBe(true);
  });
});
