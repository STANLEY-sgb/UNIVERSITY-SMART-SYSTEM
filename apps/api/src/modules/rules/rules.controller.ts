import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { RulesService } from './rules.service';

class SaveRuleDto {
  @ApiProperty({ description: 'Rule definition (schemaVersion 1). Validated; never executed as code.' })
  @IsObject() definition!: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) changeNote?: string;
}
class PublishDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class RollbackDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class TestRuleDto {
  @ApiProperty() @IsObject() definition!: Record<string, unknown>;
  @ApiProperty({ example: '2026-BCS-0001' }) @IsString() @MaxLength(32) regNo!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() context?: Record<string, unknown>;
}

@ApiTags('rules')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @RequirePermissions('rules.view')
  @Get('services/:code/rule')
  get(@Param('code') code: string) {
    return this.rules.get(code);
  }

  @RequirePermissions('rules.view')
  @Get('services/:code/rule/history')
  history(@Param('code') code: string) {
    return this.rules.history(code);
  }

  @RequirePermissions('rules.manage')
  @Put('services/:code/rule')
  save(@Param('code') code: string, @Body() dto: SaveRuleDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.rules.saveDraft(code, dto.definition, dto.changeNote, u, meta);
  }

  @RequirePermissions('rules.manage')
  @Post('services/:code/rule/versions/:version/publish')
  publish(@Param('code') code: string, @Param('version', ParseIntPipe) version: number, @Body() dto: PublishDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.rules.publish(code, version, u, meta, dto.note);
  }

  @RequirePermissions('rules.manage')
  @Post('services/:code/rule/versions/:version/rollback')
  rollback(@Param('code') code: string, @Param('version', ParseIntPipe) version: number, @Body() dto: RollbackDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.rules.rollback(code, version, dto.reason, u, meta);
  }

  @RequirePermissions('rules.view')
  @Post('rules/test')
  test(@Body() dto: TestRuleDto) {
    return this.rules.test(dto.definition, dto.regNo, dto.context);
  }
}
