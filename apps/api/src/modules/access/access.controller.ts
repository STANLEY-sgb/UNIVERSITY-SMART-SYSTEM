import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ReaderAuthGuard, ReaderContext } from '../readers/reader-auth.guard';
import { AccessService } from './access.service';
import { TapService } from './tap.service';
import { EligibilityService } from './eligibility.service';
import { OfflineService } from './offline.service';

class CredentialDto {
  @ApiProperty({ enum: ['QR', 'TAP', 'FACE'] }) @IsIn(['QR', 'TAP', 'FACE']) type!: 'QR' | 'TAP' | 'FACE';
  @ApiPropertyOptional({ description: 'FACE: claimed registration number (1:1 verification)' }) @ValidateIf((o: CredentialDto) => o.type === 'FACE') @IsString() @MaxLength(32) regNo?: string;
  @ApiPropertyOptional({ description: 'FACE: 3-8 frames of 24x24 luminance values (prototype adapter)' }) @ValidateIf((o: CredentialDto) => o.type === 'FACE') @IsArray() @ArrayMinSize(3) @ArrayMaxSize(8) frames?: number[][];
  @ApiPropertyOptional({ description: 'QR: KIU1.<payload>.<signature>' }) @ValidateIf((o: CredentialDto) => o.type === 'QR') @IsString() @MaxLength(1024) token?: string;
  @ApiPropertyOptional({ description: 'TAP: session from /access/tap/begin' }) @ValidateIf((o: CredentialDto) => o.type === 'TAP') @IsUUID() sessionId?: string;
  @ApiPropertyOptional() @ValidateIf((o: CredentialDto) => o.type === 'TAP') @Matches(/^[0-9a-fA-F]{32}$/) ivHex?: string;
  @ApiPropertyOptional() @ValidateIf((o: CredentialDto) => o.type === 'TAP') @Matches(/^[0-9a-fA-F]{32,512}$/) ctHex?: string;
  @ApiPropertyOptional() @ValidateIf((o: CredentialDto) => o.type === 'TAP') @Matches(/^[0-9a-fA-F]{32}$/) macHex?: string;
}
class TapBeginDto {
  @ApiProperty({ description: '7-byte UID returned by SELECT' }) @Matches(/^[0-9A-Fa-f]{14}$/) uidHex!: string;
}
class TapAuthDto {
  @IsUUID() sessionId!: string;
  @Matches(/^[0-9a-fA-F]{32}$/) rndCHex!: string;
  @Matches(/^[0-9a-fA-F]{32}$/) proofHex!: string;
}
class OfflineEntryDto {
  @Matches(/^[A-Za-z0-9_-]{16,64}$/) idempotencyKey!: string;
  @IsString() @MaxLength(64) cardNumber!: string;
  @IsIn(['GRANT', 'DENY']) decision!: 'GRANT' | 'DENY';
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/) reasonCode!: string;
  @IsDateString() occurredAt!: string;
  @IsOptional() @IsIn(['ENTRY', 'EXIT']) direction?: 'ENTRY' | 'EXIT';
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) counter!: number;
  @IsInt() @Min(0) manifestVersion!: number;
}
class OfflineLogsDto {
  @Matches(/^[A-Za-z0-9_-]{16,64}$/) batchKey!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => OfflineEntryDto) entries!: OfflineEntryDto[];
}
class VerifyContextDto {
  @IsOptional() @IsUUID() examSessionId?: string;
  @IsOptional() @IsString() @MaxLength(20) courseUnitCode?: string;
}
class VerifyDto {
  @ApiPropertyOptional({ description: 'Must match the reader\'s assigned service if given.' })
  @IsOptional() @IsString() @MaxLength(32) service?: string;
  @ApiProperty() @ValidateNested() @Type(() => CredentialDto) credential!: CredentialDto;
  @ApiPropertyOptional({ enum: ['ENTRY', 'EXIT'] }) @IsOptional() @IsEnum({ ENTRY: 'ENTRY', EXIT: 'EXIT' }) direction?: 'ENTRY' | 'EXIT';
  @IsOptional() @IsObject() @ValidateNested() @Type(() => VerifyContextDto) context?: VerifyContextDto;
}
class LogsQuery extends PageQuery {
  @IsOptional() @IsEnum({ GRANT: 'GRANT', DENY: 'DENY' }) decision?: 'GRANT' | 'DENY';
  @IsOptional() @IsString() @MaxLength(32) service?: string;
  @IsOptional() @IsUUID() readerId?: string;
  @IsOptional() @IsString() @MaxLength(32) regNo?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

@ApiTags('access')
@Controller()
export class AccessController {
  constructor(
    private readonly access: AccessService, private readonly tap: TapService, private readonly prisma: PrismaService,
    private readonly offline: OfflineService, private readonly eligibility: EligibilityService,
  ) {}

  /** Single decision entry point. Authenticated by reader HMAC, not by a user session. */
  @Public() @UseGuards(ReaderAuthGuard)
  @ApiHeader({ name: 'X-Reader-Key-Id' }) @ApiHeader({ name: 'X-Timestamp', description: 'unix seconds' })
  @ApiHeader({ name: 'X-Nonce' }) @ApiHeader({ name: 'X-Signature', description: 'HMAC-SHA256(method\\nurl\\nts\\nnonce\\nsha256(body))' })
  @Post('access/verify')
  @HttpCode(200)
  verify(@Req() req: { reader: ReaderContext; headers: Record<string, string> }, @Body() dto: VerifyDto) {
    const { credential: c, ...rest } = dto;
    const credential = c.type === 'QR'
      ? { type: 'QR' as const, token: c.token! }
      : c.type === 'FACE' ? { type: 'FACE' as const, regNo: c.regNo!, frames: c.frames! }
      : { type: 'TAP' as const, sessionId: c.sessionId!, ivHex: c.ivHex!, ctHex: c.ctHex!, macHex: c.macHex! };
    return this.access.verify(req.reader, { ...rest, credential, requestNonce: req.headers['x-nonce'] });
  }

  /** Virtual-card tap, step 1: reader relays the UID from SELECT; server (SAM) answers with a fresh challenge. */
  @Public() @UseGuards(ReaderAuthGuard)
  @Post('access/tap/begin')
  @HttpCode(200)
  tapBegin(@Req() req: { reader: ReaderContext }, @Body() dto: TapBeginDto) {
    return this.tap.begin(req.reader, dto.uidHex);
  }

  /** Step 2: card's proof in, SAM proof out (mutual authentication). One attempt per session. */
  @Public() @UseGuards(ReaderAuthGuard)
  @Post('access/tap/auth')
  @HttpCode(200)
  tapAuth(@Req() req: { reader: ReaderContext }, @Body() dto: TapAuthDto) {
    return this.tap.authenticate(req.reader, dto);
  }

  /** Signed offline allow-list for the calling reader (PDF: GET /readers/:id/allowlist). :id must be the caller itself. */
  @Public() @UseGuards(ReaderAuthGuard)
  @Get('readers/:id/allowlist')
  allowlist(@Req() req: { reader: ReaderContext }, @Param('id', ParseUUIDPipe) id: string) {
    if (id !== req.reader.id) throw new ForbiddenException({ code: 'READER_MISMATCH', message: 'A reader may only fetch its own allow-list' });
    return this.offline.manifest(req.reader);
  }

  /** Idempotent upload of decisions made offline (PDF: POST /readers/:id/logs). */
  @Public() @UseGuards(ReaderAuthGuard)
  @Post('readers/:id/logs')
  @HttpCode(200)
  offlineLogs(@Req() req: { reader: ReaderContext }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfflineLogsDto) {
    if (id !== req.reader.id) throw new ForbiddenException({ code: 'READER_MISMATCH', message: 'A reader may only upload its own logs' });
    return this.offline.uploadLogs(req.reader, dto);
  }

  /** What the signed-in student can use now, with reasons and the office to contact. */
  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('me.eligibility.view')
  @Get('me/eligibility')
  async myEligibility(@CurrentUser() u: AuthUser) {
    if (!u.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    return this.eligibility.forStudent(u.studentId);
  }

  /** The signed-in student's own access history (never anyone else's). */
  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('me.view')
  @Get('me/access-history')
  async myHistory(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    if (!u.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const where = { studentId: u.studentId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.accessLog.findMany({
        where, orderBy: { occurredAt: 'desc' }, skip: q.skip, take: q.pageSize,
        select: { id: true, occurredAt: true, decision: true, reasonCode: true, message: true, authMethod: true, direction: true, offline: true, service: { select: { code: true, name: true } }, venue: { select: { name: true } } },
      }),
      this.prisma.accessLog.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('me.view')
  @Get('me/notifications')
  async myNotifications(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    if (!u.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const where = { studentId: u.studentId };
    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize, select: { id: true, kind: true, title: true, body: true, readAt: true, createdAt: true } }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return { ...paged(rows, total, q), unread };
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('me.view')
  @Post('me/notifications/read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() u: AuthUser): Promise<void> {
    if (!u.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    await this.prisma.notification.updateMany({ where: { studentId: u.studentId, readAt: null }, data: { readAt: new Date() } });
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('access.logs.view')
  @Get('logs')
  async logs(@Query() q: LogsQuery) {
    const where: Prisma.AccessLogWhereInput = {
      ...(q.decision ? { decision: q.decision } : {}),
      ...(q.service ? { service: { code: q.service.toUpperCase() } } : {}),
      ...(q.readerId ? { readerId: q.readerId } : {}),
      ...(q.regNo ? { student: { regNo: q.regNo.toUpperCase() } } : {}),
      ...((q.from || q.to) ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.accessLog.findMany({
        where, orderBy: { occurredAt: 'desc' }, skip: q.skip, take: q.pageSize,
        select: {
          id: true, occurredAt: true, decision: true, reasonCode: true, message: true, authMethod: true, direction: true, offline: true, processingMs: true,
          service: { select: { code: true } }, reader: { select: { code: true } }, student: { select: { regNo: true, fullName: true } },
        },
      }),
      this.prisma.accessLog.count({ where }),
    ]);
    return paged(rows, total, q);
  }
}
