import { FORBIDDEN_SEGMENTS, Leaf, Node, RuleDefinition } from './schema';

export type Facts = Record<string, unknown>;

export interface Failure {
  reason: string;
  message: string;
  fact?: string;
}

export interface EvalResult {
  allowed: boolean;
  /** First unmet criterion (null when allowed). */
  failure: Failure | null;
  /** Every leaf evaluated, in order — for rule preview/testing. */
  trace: { fact: string; op: string; passed: boolean; actual: unknown }[];
}

/** Reason used when a required fact is missing: unknown eligibility ⇒ DENY (fail closed). */
export const FACT_UNKNOWN = 'FACT_UNKNOWN';

const UNKNOWN = Symbol('unknown');

function lookup(path: string, facts: Facts, ctx: Facts): unknown {
  let source: unknown = facts;
  let segments = path.split('.');
  if (segments[0] === 'ctx') {
    source = ctx;
    segments = segments.slice(1);
  }
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.includes(seg)) return UNKNOWN;
    if (source === null || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, seg)) return UNKNOWN;
    source = (source as Record<string, unknown>)[seg];
  }
  return source === undefined || source === null ? UNKNOWN : source;
}

function resolveOperand(v: unknown, facts: Facts, ctx: Facts): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { ctx?: string; fact?: string };
    if (typeof o.ctx === 'string') return lookup(`ctx.${o.ctx}`, facts, ctx);
    if (typeof o.fact === 'string') return lookup(o.fact, facts, ctx);
  }
  return v;
}

function toComparable(v: unknown, datetime: boolean): number | string | boolean | null {
  if (datetime) {
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
  }
  // Only primitives are comparable. The fact loader must convert Decimal/Date values first.
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return null;
}

function compare(op: Leaf['op'], actual: unknown, expected: unknown, datetime: boolean): boolean | typeof UNKNOWN {
  if (op === 'contains') {
    const exp = expected;
    if (Array.isArray(actual)) return actual.some((a) => a === exp);
    if (typeof actual === 'string' && typeof exp === 'string') return actual.includes(exp);
    return false;
  }
  if (op === 'in') {
    if (!Array.isArray(expected)) return false;
    const a = toComparable(actual, datetime);
    return expected.some((e) => toComparable(e, datetime) === a);
  }
  if (op === 'between') {
    if (!Array.isArray(expected) || expected.length !== 2) return false;
    const a = toComparable(actual, datetime), lo = toComparable(expected[0], datetime), hi = toComparable(expected[1], datetime);
    if (a === null || lo === null || hi === null || typeof a !== typeof lo || typeof a !== typeof hi) return false;
    return a >= lo && a <= hi;
  }
  const a = toComparable(actual, datetime);
  const e = toComparable(expected, datetime);
  if (a === null || e === null) return op === 'neq' ? a !== e : false;
  if (op === 'eq') return a === e;
  if (op === 'neq') return a !== e;
  if (typeof a !== typeof e) return false;
  switch (op) {
    case 'gt': return a > e;
    case 'gte': return a >= e;
    case 'lt': return a < e;
    case 'lte': return a <= e;
    default: return false;
  }
}

function evalLeaf(leaf: Leaf, facts: Facts, ctx: Facts, trace: EvalResult['trace']): Failure | null {
  const actual = lookup(leaf.fact, facts, ctx);
  if (actual === UNKNOWN) {
    trace.push({ fact: leaf.fact, op: leaf.op, passed: false, actual: undefined });
    return { reason: FACT_UNKNOWN, message: 'Eligibility could not be determined. Please contact the relevant office.', fact: leaf.fact };
  }
  const raw = Array.isArray(leaf.value)
    ? leaf.value.map((v) => resolveOperand(v, facts, ctx))
    : resolveOperand(leaf.value, facts, ctx);
  if (raw === UNKNOWN || (Array.isArray(raw) && raw.includes(UNKNOWN))) {
    trace.push({ fact: leaf.fact, op: leaf.op, passed: false, actual });
    return { reason: FACT_UNKNOWN, message: 'Eligibility could not be determined. Please contact the relevant office.', fact: leaf.fact };
  }
  const ok = compare(leaf.op, actual, raw, leaf.type === 'datetime') === true;
  trace.push({ fact: leaf.fact, op: leaf.op, passed: ok, actual });
  return ok ? null : { reason: leaf.reason, message: leaf.message, fact: leaf.fact };
}

function evalNode(node: Node, facts: Facts, ctx: Facts, trace: EvalResult['trace']): Failure | null {
  if ('all' in node) {
    for (const child of node.all) {
      const f = evalNode(child, facts, ctx, trace);
      if (f) return f; // first unmet criterion gives the precise denial
    }
    return null;
  }
  if ('any' in node) {
    let first: Failure | null = null;
    for (const child of node.any) {
      const f = evalNode(child, facts, ctx, trace);
      if (!f) return null;
      first ??= f;
    }
    if (node.message || node.reason) return { reason: node.reason ?? first!.reason, message: node.message ?? first!.message };
    return first;
  }
  if ('not' in node) {
    const inner = evalNode(node.not, facts, ctx, []);
    // A "not" over an unknown fact must not turn ignorance into a grant.
    if (inner?.reason === FACT_UNKNOWN) return inner;
    return inner ? null : { reason: node.reason, message: node.message };
  }
  return evalLeaf(node, facts, ctx, trace);
}

/**
 * Pure, deterministic evaluation. No eval, no Function, no I/O: the rule is data and facts are plain values.
 * The same facts + context always produce the same decision regardless of how the student authenticated.
 */
export function evaluate(rule: RuleDefinition, facts: Facts, context: Facts = {}): EvalResult {
  const trace: EvalResult['trace'] = [];
  const failure = evalNode(rule.requirements, facts, context, trace);
  return { allowed: failure === null, failure, trace };
}
