import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PermissionCode } from '@kiu/shared';

export const IS_PUBLIC = 'isPublic';
/** Route needs no authentication (login, health, ...). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMISSIONS_KEY = 'requiredPermissions';
/** Caller must hold ALL listed permissions. Enforced server-side by PermissionsGuard. */
export const RequirePermissions = (...perms: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const ALLOW_MFA_SETUP = 'allowMfaSetup';
/** Reachable while the session is still in the "MFA enrolment required" state. */
export const AllowMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP, true);

export const SELF_SERVICE = 'selfService';
/** Any authenticated, fully-verified user (permissions are checked inside, e.g. /auth/me). */
export const Authenticated = () => SetMetadata(SELF_SERVICE, true);

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  userType: 'STAFF' | 'STUDENT';
  studentId: string | null;
  roles: string[];
  permissions: string[];
  sessionId: string;
  mfaSetupRequired: boolean;
  via: 'cookie' | 'bearer';
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});

export interface RequestMeta {
  ip: string | undefined;
  userAgent: string | undefined;
  requestId: string | undefined;
}

export const ReqMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest();
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.requestId };
});
