import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { MFA_REQUIRED_ROLES } from '@kiu/shared';
import { safeEqual } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ALLOW_MFA_SETUP, AuthUser, IS_PUBLIC, PERMISSIONS_KEY, SELF_SERVICE,
} from '../../common/decorators';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER } from './auth.constants';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface AccessClaims {
  sub: string;
  sid: string;
}

/**
 * Global guard #1: authenticates the caller. The session row is re-checked on every request,
 * so revoking a session or disabling a user takes effect immediately (not at token expiry).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    const token = bearer ?? cookieToken;
    const via: AuthUser['via'] = bearer ? 'bearer' : 'cookie';
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required' });

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Invalid or expired token' });
    }

    // CSRF: cookie-authenticated unsafe requests must echo the double-submit token.
    if (via === 'cookie' && !SAFE_METHODS.has(req.method)) {
      const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
      const sent = req.headers[CSRF_HEADER];
      if (!cookie || typeof sent !== 'string' || !safeEqual(cookie, sent)) {
        throw new ForbiddenException({ code: 'CSRF_FAILED', message: 'CSRF token missing or invalid' });
      }
    }

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      include: {
        user: {
          include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
        },
      },
    });
    if (!session || session.revokedAt || session.userId !== claims.sub || session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Session is no longer valid' });
    }

    const roles = session.user.roles.map((ur) => ur.role.code);
    const permissions = [...new Set(session.user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.code)))];
    const mfaSetupRequired = !session.user.mfaEnabled && roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));

    req.user = {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      userType: session.user.userType,
      studentId: session.user.studentId,
      roles,
      permissions,
      sessionId: session.id,
      mfaSetupRequired,
      via,
    };
    return true;
  }
}

/**
 * Global guard #2: authorisation. Fail-closed — a route must declare @Public(),
 * @Authenticated() or @RequirePermissions(); anything else is denied.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required' });

    const allowMfaSetup = this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_SETUP, targets);
    if (user.mfaSetupRequired && !allowMfaSetup) {
      throw new ForbiddenException({ code: 'MFA_ENROLMENT_REQUIRED', message: 'Enable multi-factor authentication to continue' });
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    if (required && required.length > 0) {
      const missing = required.filter((p) => !user.permissions.includes(p));
      if (missing.length > 0) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
      }
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(SELF_SERVICE, targets) || allowMfaSetup) return true;

    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Route has no access policy' });
  }
}
