import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from './audit.service';

class AuditQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) actorId?: string;
}

@ApiTags('audit')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @RequirePermissions('audit.view')
  @Get()
  async list(@Query() q: AuditQuery) {
    const where = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditTrail.findMany({
        where, orderBy: { seq: 'desc' }, skip: q.skip, take: q.pageSize,
        select: { seq: true, id: true, at: true, actorId: true, actorType: true, action: true, entityType: true, entityId: true, before: true, after: true, reason: true, hash: true },
      }),
      this.prisma.auditTrail.count({ where }),
    ]);
    return paged(rows.map((r) => ({ ...r, seq: r.seq.toString() })), total, q);
  }

  /** Recomputes the hash chain and reports the first tampered entry, if any. */
  @RequirePermissions('audit.view')
  @Get('verify')
  verify() {
    return this.audit.verifyChain();
  }
}
