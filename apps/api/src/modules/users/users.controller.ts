import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('users.view')
  @Get('users')
  list(@Query() q: ListUsersQuery) {
    return this.users.list(q);
  }

  @RequirePermissions('users.view')
  @Get('users/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @RequirePermissions('users.manage')
  @Post('users')
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.users.create(dto, actor, meta);
  }

  @RequirePermissions('users.manage')
  @Patch('users/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.users.update(id, dto, actor, meta);
  }

  @RequirePermissions('users.view')
  @Get('roles')
  roles() {
    return this.users.roles();
  }

  @RequirePermissions('users.view')
  @Get('permissions')
  permissions() {
    return this.users.permissions();
  }
}
