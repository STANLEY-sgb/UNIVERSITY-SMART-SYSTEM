import { Body, ConflictException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, IsNumber, IsEnum } from 'class-validator';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery } from '../../common/pagination';
import { BiometricsService, NOTICE_VERSION } from './biometrics.service';
import { MAX_FRAMES, MIN_FRAMES } from './mock-adapter';

class EnrolDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty({ example: NOTICE_VERSION }) @IsString() @MaxLength(80) noticeVersion!: string;
  @ApiProperty({ description: 'The student confirmed, in person, that they have read the notice and agree.' }) @IsBoolean() consentConfirmed!: boolean;
  @ApiProperty({ description: `${MIN_FRAMES}-${MAX_FRAMES} frames of 24x24 luminance values (0-255), row-major. No image is ever uploaded.` })
  @IsArray() @ArrayMinSize(MIN_FRAMES) @ArrayMaxSize(MAX_FRAMES) frames!: number[][];
}
class ReasonDto { @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string }
class ListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsEnum({ ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', REVOKED: 'REVOKED', DELETED: 'DELETED', PENDING: 'PENDING' }) status?: string;
}
class ExemptionDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(300) reason!: string;
}
class PolicyDto {
  @ApiPropertyOptional({ minimum: 0.5, maximum: 0.99 }) @IsOptional() @IsNumber() @Min(0.5) @Max(0.99) matchThreshold?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() faceEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Face enrolment is compulsory for every student' }) @IsOptional() @IsBoolean() enrolmentRequired?: boolean;
  @ApiPropertyOptional({ example: '2027-02-01', nullable: true, description: 'From this date students who are neither enrolled nor exempt are refused. null removes the date.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) enforceFrom?: string | null;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class DeviceDto {
  @ApiProperty() @IsBoolean() authorised!: boolean;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}

@ApiTags('biometrics')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class BiometricsController {
  constructor(private readonly bio: BiometricsService) {}

  @RequirePermissions('biometrics.enroll')
  @Get('biometrics/notice')
  async notice() { return { ...(await this.bio.notice()), prototypeOnly: this.bio.adapter.isMock, engine: `${this.bio.adapter.name}@${this.bio.adapter.version}` }; }

  @RequirePermissions('biometrics.view')
  @Get('biometrics/enrollments')
  list(@Query() q: ListQuery) { return this.bio.list(q); }

  @RequirePermissions('biometrics.enroll')
  @Post('biometrics/enrollments')
  enrol(@Body() dto: EnrolDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    if (!dto.consentConfirmed) throw new ConflictException({ code: 'CONSENT_REQUIRED', message: 'The student must give consent before enrolment.' });
    return this.bio.enrol(dto, u, meta);
  }

  @RequirePermissions('biometrics.revoke')
  @Post('biometrics/enrollments/:id/revoke')
  @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.bio.revoke(id, dto.reason, u, meta);
  }

  @RequirePermissions('biometrics.view')
  @Get('biometrics/policy')
  policy() { return this.bio.policy().then((p) => ({ ...p, prototypeOnly: this.bio.adapter.isMock, engine: `${this.bio.adapter.name}@${this.bio.adapter.version}`, oneToMany: 'disabled' })); }

  @RequirePermissions('biometrics.policy.manage')
  @Put('biometrics/policy')
  setPolicy(@Body() dto: PolicyDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.bio.setPolicy(dto, dto.reason, u, meta);
  }

  @RequirePermissions('biometrics.view')
  @Get('biometrics/devices')
  devices() { return this.bio.devices(); }

  @RequirePermissions('biometrics.policy.manage')
  @Put('biometrics/devices/:readerId')
  device(@Param('readerId', ParseUUIDPipe) id: string, @Body() dto: DeviceDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.bio.setDevice(id, dto.authorised, dto.reason, u, meta);
  }

  @RequirePermissions('biometrics.view')
  @Get('biometrics/pending')
  pending(@Query() q: PageQuery) { return this.bio.pending(q); }

  @RequirePermissions('biometrics.policy.manage')
  @Post('biometrics/exemptions')
  exempt(@Body() dto: ExemptionDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.bio.grantExemption(dto.regNo, dto.reason, u, meta); }

  @RequirePermissions('biometrics.policy.manage')
  @Post('biometrics/exemptions/revoke')
  @HttpCode(200)
  unexempt(@Body() dto: ExemptionDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.bio.revokeExemption(dto.regNo, dto.reason, u, meta); }

  // Student self-service

  @RequirePermissions('me.biometrics.manage')
  @Get('me/biometrics')
  mine(@CurrentUser() u: AuthUser) { return this.bio.mine(u); }

  @RequirePermissions('me.biometrics.manage')
  @Post('me/biometrics/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) { return this.bio.withdrawOwn(u, meta); }
}
