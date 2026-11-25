import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { CreateStudentDto, ListStudentsQuery, UpdateStudentStatusDto } from './students.dto';
import { StudentsService } from './students.service';

@ApiTags('students')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @RequirePermissions('students.view')
  @Get()
  list(@Query() q: ListStudentsQuery) {
    return this.students.list(q);
  }

  @RequirePermissions('students.view')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.get(id);
  }

  @RequirePermissions('students.create')
  @Post()
  create(@Body() dto: CreateStudentDto, @CurrentUser() actor: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.students.create(dto, actor, meta);
  }

  @RequirePermissions('students.update')
  @Patch(':regNo/status')
  updateStatus(@Param('regNo') regNo: string, @Body() dto: UpdateStudentStatusDto, @CurrentUser() actor: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.students.updateStatus(regNo, dto, actor, meta);
  }
}
