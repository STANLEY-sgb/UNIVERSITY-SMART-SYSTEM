import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './users.dto';

/** Roles that only a Super Administrator may grant or remove (prevents privilege escalation). */
const PROTECTED_ROLES = ['SUPER_ADMIN'];

const userSelect = {
  id: true, email: true, displayName: true, userType: true, status: true, mfaEnabled: true,
  lastLoginAt: true, createdAt: true, studentId: true,
  roles: { select: { role: { select: { code: true, name: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function shape(u: UserRow) {
  const { roles, ...rest } = u;
  return { ...rest, roles: roles.map((r) => r.role.code) };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {
      ...(q.userType ? { userType: q.userType } : {}),
      ...(q.role ? { roles: { some: { role: { code: q.role } } } } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { displayName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.user.count({ where }),
    ]);
    return paged(rows.map(shape), total, q);
  }

  async get(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!u) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return shape(u);
  }

  private async resolveRoles(codes: string[], actor: AuthUser) {
    const unique = [...new Set(codes)];
    const roles = await this.prisma.role.findMany({ where: { code: { in: unique } } });
    if (roles.length !== unique.length) {
      throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: 'One or more roles do not exist' });
    }
    if (unique.includes('STUDENT')) {
      throw new BadRequestException({ code: 'ROLE_NOT_ASSIGNABLE', message: 'The STUDENT role is assigned automatically to student accounts' });
    }
    if (unique.some((c) => PROTECTED_ROLES.includes(c)) && !actor.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException({ code: 'ESCALATION_BLOCKED', message: 'Only a Super Administrator can grant this role' });
    }
    return roles;
  }

  async create(dto: CreateUserDto, actor: AuthUser, meta: RequestMeta) {
    const email = dto.email.trim().toLowerCase();
    this.auth.assertPolicy(dto.password, email);
    const roles = await this.resolveRoles(dto.roleCodes, actor);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException({ code: 'EMAIL_IN_USE', message: 'A user with this email already exists' });
    }
    const passwordHash = await this.auth.hashPassword(dto.password);
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email, displayName: dto.displayName.trim(), passwordHash, userType: 'STAFF', mustChangePassword: true,
          roles: { create: roles.map((r) => ({ roleId: r.id, assignedBy: actor.id })) },
        },
        select: userSelect,
      });
      await this.audit.record({ actorId: actor.id, action: 'users.create', entityType: 'User', entityId: u.id, after: shape(u), requestMeta: meta }, tx);
      return u;
    });
    return shape(created);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser, meta: RequestMeta) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!before) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const beforeShape = shape(before);

    if (id === actor.id && (dto.roleCodes || dto.status)) {
      throw new ForbiddenException({ code: 'SELF_MODIFICATION_BLOCKED', message: 'You cannot change your own roles or status' });
    }
    if (before.userType === 'STUDENT' && dto.roleCodes) {
      throw new BadRequestException({ code: 'ROLE_NOT_ASSIGNABLE', message: 'Student accounts cannot be given staff roles' });
    }
    // Touching an existing Super Administrator is itself a protected action.
    if (beforeShape.roles.some((r) => PROTECTED_ROLES.includes(r)) && !actor.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException({ code: 'ESCALATION_BLOCKED', message: 'Only a Super Administrator can modify this account' });
    }
    if ((dto.roleCodes || dto.status) && !dto.reason) {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required when changing roles or status' });
    }
    const roles = dto.roleCodes ? await this.resolveRoles(dto.roleCodes, actor) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id, assignedBy: actor.id })) });
      }
      const u = await tx.user.update({
        where: { id },
        data: {
          ...(dto.displayName ? { displayName: dto.displayName.trim() } : {}),
          ...(dto.status ? { status: dto.status, ...(dto.status === 'ACTIVE' ? { failedLogins: 0, lockedUntil: null } : {}) } : {}),
        },
        select: userSelect,
      });
      await this.audit.record({
        actorId: actor.id, action: 'users.update', entityType: 'User', entityId: id,
        before: beforeShape, after: shape(u), reason: dto.reason ?? null, requestMeta: meta,
      }, tx);
      return u;
    });

    if (dto.status && dto.status !== 'ACTIVE') await this.auth.revokeAllSessions(id, `status_${dto.status.toLowerCase()}`);
    if (roles) await this.auth.revokeAllSessions(id, 'roles_changed');
    return shape(updated);
  }

  async roles() {
    const rows = await this.prisma.role.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true, description: true, isSystem: true, permissions: { select: { permission: { select: { code: true } } } } },
    });
    return rows.map((r) => ({ code: r.code, name: r.name, description: r.description, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.code).sort() }));
  }

  permissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' }, select: { code: true, description: true } });
  }
}

export type { PageQuery };
