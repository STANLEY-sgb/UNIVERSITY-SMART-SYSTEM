import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RuleDefinition, evaluate, validateRule } from '@kiu/rules-engine';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FactsService } from '../access/facts.service';

@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly facts: FactsService,
  ) {}

  private async ruleFor(code: string) {
    const service = await this.prisma.service.findUnique({ where: { code: code.toUpperCase() }, include: { rules: true } });
    if (!service) throw new NotFoundException({ code: 'SERVICE_NOT_FOUND', message: 'Service not found' });
    const rule = service.rules[0] ?? await this.prisma.accessRule.create({ data: { serviceId: service.id } });
    return { service, rule };
  }

  private assertValid(definition: unknown): RuleDefinition {
    const v = validateRule(definition);
    if (!v.ok) throw new BadRequestException({ code: 'RULE_INVALID', message: 'Rule definition is invalid', details: v.errors });
    return v.definition!;
  }

  async get(code: string) {
    const { service, rule } = await this.ruleFor(code);
    const versions = await this.prisma.accessRuleVersion.findMany({ where: { ruleId: rule.id }, orderBy: { version: 'desc' } });
    const published = versions.find((v) => v.id === rule.publishedVersionId) ?? null;
    const draft = versions.find((v) => v.status === 'DRAFT') ?? null;
    return { service: { code: service.code, name: service.name }, published, draft };
  }

  history(code: string) {
    return this.ruleFor(code).then(({ rule }) =>
      this.prisma.accessRuleVersion.findMany({
        where: { ruleId: rule.id }, orderBy: { version: 'desc' },
        select: { id: true, version: true, status: true, changeNote: true, createdBy: true, publishedBy: true, publishedAt: true, createdAt: true },
      }));
  }

  /** PUT /services/:code/rule — saves a new DRAFT (replacing any previous unpublished draft). */
  async saveDraft(code: string, definition: unknown, changeNote: string | undefined, actor: AuthUser, meta: RequestMeta) {
    const def = this.assertValid(definition);
    const { rule } = await this.ruleFor(code);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.accessRuleVersion.findFirst({ where: { ruleId: rule.id }, orderBy: { version: 'desc' } });
      await tx.accessRuleVersion.updateMany({ where: { ruleId: rule.id, status: 'DRAFT' }, data: { status: 'ARCHIVED' } });
      const created = await tx.accessRuleVersion.create({
        data: { ruleId: rule.id, version: (last?.version ?? 0) + 1, status: 'DRAFT', definition: def as unknown as Prisma.InputJsonValue, changeNote: changeNote ?? null, createdBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: 'rules.draft_saved', entityType: 'AccessRule', entityId: rule.id, after: { service: code.toUpperCase(), version: created.version }, reason: changeNote ?? null, requestMeta: meta }, tx);
      return created;
    });
  }

  /** Publishes a DRAFT or re-publishes nothing else: previous published version is archived. */
  async publish(code: string, version: number, actor: AuthUser, meta: RequestMeta, note?: string) {
    const { rule } = await this.ruleFor(code);
    const target = await this.prisma.accessRuleVersion.findUnique({ where: { ruleId_version: { ruleId: rule.id, version } } });
    if (!target) throw new NotFoundException({ code: 'RULE_VERSION_NOT_FOUND', message: 'Rule version not found' });
    if (target.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_A_DRAFT', message: 'Only a draft can be published; use rollback to restore an older version' });
    this.assertValid(target.definition); // re-validate at the publication gate
    return this.prisma.$transaction(async (tx) => {
      const previous = rule.publishedVersionId;
      if (previous) await tx.accessRuleVersion.update({ where: { id: previous }, data: { status: 'ARCHIVED' } });
      const published = await tx.accessRuleVersion.update({ where: { id: target.id }, data: { status: 'PUBLISHED', publishedBy: actor.id, publishedAt: new Date(), effectiveFrom: new Date() } });
      await tx.accessRule.update({ where: { id: rule.id }, data: { publishedVersionId: published.id } });
      await this.audit.record({ actorId: actor.id, action: 'rules.published', entityType: 'AccessRule', entityId: rule.id, before: { publishedVersionId: previous }, after: { publishedVersionId: published.id, version }, reason: note ?? null, requestMeta: meta }, tx);
      return published;
    });
  }

  /** Rollback = publish a fresh copy of an older definition, so history stays linear and auditable. */
  async rollback(code: string, toVersion: number, reason: string, actor: AuthUser, meta: RequestMeta) {
    const { rule } = await this.ruleFor(code);
    const old = await this.prisma.accessRuleVersion.findUnique({ where: { ruleId_version: { ruleId: rule.id, version: toVersion } } });
    if (!old) throw new NotFoundException({ code: 'RULE_VERSION_NOT_FOUND', message: 'Rule version not found' });
    this.assertValid(old.definition);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.accessRuleVersion.findFirstOrThrow({ where: { ruleId: rule.id }, orderBy: { version: 'desc' } });
      if (rule.publishedVersionId) await tx.accessRuleVersion.update({ where: { id: rule.publishedVersionId }, data: { status: 'ARCHIVED' } });
      const copy = await tx.accessRuleVersion.create({
        data: { ruleId: rule.id, version: last.version + 1, status: 'PUBLISHED', definition: old.definition as Prisma.InputJsonValue, changeNote: `Rollback to v${toVersion}: ${reason}`, createdBy: actor.id, publishedBy: actor.id, publishedAt: new Date(), effectiveFrom: new Date() },
      });
      await tx.accessRule.update({ where: { id: rule.id }, data: { publishedVersionId: copy.id } });
      await this.audit.record({ actorId: actor.id, action: 'rules.rolled_back', entityType: 'AccessRule', entityId: rule.id, before: { publishedVersionId: rule.publishedVersionId }, after: { publishedVersionId: copy.id, restoredFrom: toVersion }, reason, requestMeta: meta }, tx);
      return copy;
    });
  }

  /** Dry-run a definition against a real student's current facts. Writes nothing. */
  async test(definition: unknown, regNo: string, context: Record<string, unknown> = {}) {
    const def = this.assertValid(definition);
    const student = await this.prisma.student.findUnique({ where: { regNo: regNo.toUpperCase() } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    const facts = await this.facts.loadFacts(student.id, null);
    const base = await this.facts.baseContext();
    const result = evaluate(def, facts, { ...base, ...context });
    return { regNo: student.regNo, allowed: result.allowed, failure: result.failure, trace: result.trace };
  }
}
