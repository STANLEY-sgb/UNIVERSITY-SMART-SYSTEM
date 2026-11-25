import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, Public, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery } from '../../common/pagination';
import { ReaderAuthGuard, ReaderContext } from './reader-auth.guard';
import { ReadersService } from './readers.service';

class CreateReaderDto {
  @ApiProperty({ example: 'RDR-GATE-01' }) @IsString() @Matches(/^[A-Z0-9][A-Z0-9-]{2,31}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiProperty({ example: 'GATE' }) @IsString() @MaxLength(32) serviceCode!: string;
  @ApiProperty({ example: 'GATE-MAIN' }) @IsString() @MaxLength(32) venueCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() supportsFace?: boolean;
}
class ReaderStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED', 'REVOKED'] }) @IsEnum({ ACTIVE: 'ACTIVE', DISABLED: 'DISABLED', REVOKED: 'REVOKED' }) status!: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class HeartbeatDto {
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) queuedLogs?: number;
  @IsOptional() @IsInt() @Min(0) cacheVersion?: number;
}

@ApiTags('readers')
@Controller('readers')
export class ReadersController {
  constructor(private readonly readers: ReadersService) {}

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('readers.view')
  @Get()
  list(@Query() q: PageQuery) {
    return this.readers.list(q);
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('readers.view')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.readers.get(id);
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('readers.manage')
  @Post()
  create(@Body() dto: CreateReaderDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.readers.create(dto, u, meta);
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('readers.manage')
  @Patch(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReaderStatusDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.readers.setStatus(id, dto.status, dto.reason, u, meta);
  }

  @ApiBearerAuth() @ApiCookieAuth() @RequirePermissions('readers.manage')
  @Post(':id/rotate-credential')
  @HttpCode(200)
  rotate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.readers.rotateCredential(id, u, meta);
  }

  /** Device endpoint: HMAC-authenticated, no user session. */
  @Public() @UseGuards(ReaderAuthGuard)
  @ApiHeader({ name: 'X-Reader-Key-Id' }) @ApiHeader({ name: 'X-Timestamp' }) @ApiHeader({ name: 'X-Nonce' }) @ApiHeader({ name: 'X-Signature' })
  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(@Req() req: { reader: ReaderContext }, @Body() dto: HeartbeatDto) {
    return this.readers.heartbeat(req.reader, dto);
  }
}
