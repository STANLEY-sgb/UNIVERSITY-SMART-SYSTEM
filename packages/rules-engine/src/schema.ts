import { z } from 'zod';

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'between', 'in'] as const;
export type Op = (typeof OPS)[number];

export const MAX_DEPTH = 8;
export const MAX_NODES = 100;

const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ref = z.union([z.object({ ctx: z.string().min(1) }).strict(), z.object({ fact: z.string().min(1) }).strict()]);
const operand = z.union([primitive, ref]);
const value = z.union([operand, z.array(operand).max(50)]);

export const leafSchema = z.object({
  /** Dot path into facts; prefix `ctx.` reads the request context instead. */
  fact: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, 'invalid fact path'),
  op: z.enum(OPS),
  value,
  /** `datetime` compares as instants (ISO-8601 strings / epoch ms). */
  type: z.enum(['datetime']).optional(),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'reason must be an UPPER_SNAKE reason code'),
  message: z.string().min(1).max(200),
}).strict();

export type Leaf = z.infer<typeof leafSchema>;
export type Node = Leaf | { all: Node[]; message?: string; reason?: string } | { any: Node[]; message?: string; reason?: string } | { not: Node; reason: string; message: string };

const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ all: z.array(nodeSchema).min(1).max(50), message: z.string().max(200).optional(), reason: z.string().optional() }).strict(),
    z.object({ any: z.array(nodeSchema).min(1).max(50), message: z.string().max(200).optional(), reason: z.string().optional() }).strict(),
    z.object({ not: nodeSchema, reason: z.string().regex(/^[A-Z][A-Z0-9_]*$/), message: z.string().min(1).max(200) }).strict(),
  ]),
) as z.ZodType<Node>;

export const ruleDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  description: z.string().max(300).optional(),
  requirements: nodeSchema,
}).strict();

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  definition?: RuleDefinition;
}

function measure(node: Node, depth: number, acc: { nodes: number; maxDepth: number }): void {
  acc.nodes += 1;
  acc.maxDepth = Math.max(acc.maxDepth, depth);
  if ('all' in node) node.all.forEach((c) => measure(c, depth + 1, acc));
  else if ('any' in node) node.any.forEach((c) => measure(c, depth + 1, acc));
  else if ('not' in node) measure(node.not, depth + 1, acc);
}

/** Structural + semantic validation. Rules are data; nothing here is ever executed as code. */
export function validateRule(input: unknown): ValidationResult {
  const parsed = ruleDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const errors: string[] = [];
  const acc = { nodes: 0, maxDepth: 0 };
  measure(parsed.data.requirements, 1, acc);
  if (acc.maxDepth > MAX_DEPTH) errors.push(`rule nesting exceeds ${MAX_DEPTH} levels`);
  if (acc.nodes > MAX_NODES) errors.push(`rule has more than ${MAX_NODES} conditions`);
  const check = (n: Node, path: string): void => {
    if ('all' in n) n.all.forEach((c, i) => check(c, `${path}.all[${i}]`));
    else if ('any' in n) n.any.forEach((c, i) => check(c, `${path}.any[${i}]`));
    else if ('not' in n) check(n.not, `${path}.not`);
    else {
      if (n.op === 'between' && !(Array.isArray(n.value) && n.value.length === 2)) errors.push(`${path}: 'between' needs [low, high]`);
      if (n.op === 'in' && !Array.isArray(n.value)) errors.push(`${path}: 'in' needs an array`);
      if (!['in', 'between'].includes(n.op) && Array.isArray(n.value)) errors.push(`${path}: '${n.op}' takes a single value`);
      if (['gt', 'gte', 'lt', 'lte', 'between'].includes(n.op) && n.value === null) errors.push(`${path}: ordering operators need a non-null value`);
      for (const k of FORBIDDEN_SEGMENTS) if (n.fact.split('.').includes(k)) errors.push(`${path}: forbidden path segment '${k}'`);
    }
  };
  check(parsed.data.requirements, 'requirements');
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], definition: parsed.data };
}

export const FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype'];
