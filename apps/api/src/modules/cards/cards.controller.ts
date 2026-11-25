import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery } from '../../common/pagination';
import { CardsService } from './cards.service';

class IssueCardDto {
  @ApiProperty({ example: '2026-BCS-0001' }) @IsString() @MaxLength(32) regNo!: string;
}
class ReasonDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class ReplaceDto extends ReasonDto {
  @ApiPropertyOptional({ description: 'Replacement-fee status per KIU policy (e.g. PAID, WAIVED, PENDING).' })
  @IsOptional() @IsString() @MaxLength(40) feeStatus?: string;
}
class PatchCardDto extends ReasonDto {
  @ApiProperty({ enum: ['BLOCKED', 'ACTIVE'] }) @IsEnum({ BLOCKED: 'BLOCKED', ACTIVE: 'ACTIVE' }) status!: 'BLOCKED' | 'ACTIVE';
}
class ListCardsQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(32) regNo?: string;
  @IsOptional() @IsEnum({ PENDING: 'PENDING', ACTIVE: 'ACTIVE', BLOCKED: 'BLOCKED', LOST: 'LOST', EXPIRED: 'EXPIRED' }) status?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}
class ActivateDto {
  @ApiProperty({ example: 'ABCD-EFGH-JKLM' }) @IsString() @Matches(/^[A-Za-z0-9-\s]{8,20}$/) code!: string;
  @ApiProperty({ description: 'Ed25519 public key (32 bytes hex) generated on the device. The private key never leaves it.' })
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/) devicePublicKeyHex!: string;
  @ApiProperty({ description: 'Ed25519 signature (hex) over "KIU-ACTIVATE:<cardNumber>" proving possession of the key.' })
  @IsString() @Matches(/^[0-9a-fA-F]{128}$/) proofHex!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceLabel?: string;
}

@ApiTags('cards')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  // ── staff ──
  @RequirePermissions('cards.view') @Get('cards')
  list(@Query() q: ListCardsQuery) { return this.cards.list(q); }

  @RequirePermissions('cards.view') @Get('cards/:id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.cards.get(id); }

  @RequirePermissions('cards.view') @Get('cards/:id/history')
  history(@Param('id', ParseUUIDPipe) id: string) { return this.cards.history(id); }

  /** Issues a PENDING card + one-time activation code (shown once). Alias: POST /cards/issue. */
  @RequirePermissions('cards.issue') @Post(['cards', 'cards/issue'])
  issue(@Body() dto: IssueCardDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.issue(dto.regNo, u, meta); }

  @RequirePermissions('cards.issue') @Post('cards/:id/reset-activation') @HttpCode(200)
  reset(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.resetActivation(id, u, meta); }

  @RequirePermissions('cards.block') @Post('cards/:id/block') @HttpCode(200)
  block(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.block(id, dto.reason, u, meta); }

  @RequirePermissions('cards.block') @Post('cards/:id/unblock') @HttpCode(200)
  unblock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.unblock(id, dto.reason, u, meta); }

  @RequirePermissions('cards.block') @Post('cards/:id/report-lost') @HttpCode(200)
  lost(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.reportLost(id, dto.reason, u, meta); }

  @RequirePermissions('cards.replace') @Post('cards/:id/replace')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.cards.replace(id, dto.reason, dto.feeStatus, u, meta);
  }

  /** PDF-style update: block / unblock via status. */
  @RequirePermissions('cards.block') @Patch('cards/:id')
  patch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchCardDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return dto.status === 'BLOCKED' ? this.cards.block(id, dto.reason, u, meta) : this.cards.unblock(id, dto.reason, u, meta);
  }

  // ── student wallet ──
  @RequirePermissions('me.card.view') @Get('me/card')
  mine(@CurrentUser() u: AuthUser) { return this.cards.mine(u); }

  @RequirePermissions('me.card.view') @Post('me/card/activate') @HttpCode(200)
  activate(@Body() dto: ActivateDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.activate(u, dto, meta); }

  @RequirePermissions('me.card.report_lost') @Post('me/card/report-lost') @HttpCode(200)
  reportOwn(@Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.cards.reportOwnLost(u, dto.reason, meta); }
}
