import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './auth.guards';
import { ALLOW_MFA_SETUP, AuthUser, IS_PUBLIC, PERMISSIONS_KEY, SELF_SERVICE } from '../../common/decorators';

function ctx(user: Partial<AuthUser> | undefined, meta: Record<string, unknown>): ExecutionContext {
  const handler = () => undefined;
  const klass = class {};
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => meta[key as string] as never);
  (ctx as unknown as { reflector: Reflector }).reflector = reflector;
  return {
    getHandler: () => handler, getClass: () => klass,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardFor(user: Partial<AuthUser> | undefined, meta: Record<string, unknown>) {
  const c = ctx(user, meta);
  return { guard: new PermissionsGuard((ctx as unknown as { reflector: Reflector }).reflector), c };
}

const user = (over: Partial<AuthUser> = {}): Partial<AuthUser> => ({ permissions: [], mfaSetupRequired: false, ...over });

describe('PermissionsGuard', () => {
  it('lets public routes through without a user', () => {
    const { guard, c } = guardFor(undefined, { [IS_PUBLIC]: true });
    expect(guard.canActivate(c)).toBe(true);
  });

  it('denies by default when a route declares no access policy (fail closed)', () => {
    const { guard, c } = guardFor(user(), {});
    expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
  });

  it('requires an authenticated user for non-public routes', () => {
    const { guard, c } = guardFor(undefined, { [SELF_SERVICE]: true });
    expect(() => guard.canActivate(c)).toThrow(UnauthorizedException);
  });

  it('allows self-service routes for any authenticated user', () => {
    const { guard, c } = guardFor(user(), { [SELF_SERVICE]: true });
    expect(guard.canActivate(c)).toBe(true);
  });

  it('requires ALL listed permissions', () => {
    const need = { [PERMISSIONS_KEY]: ['students.view', 'students.update'] };
    expect(() => guardFor(user({ permissions: ['students.view'] }), need).guard.canActivate(guardFor(user({ permissions: ['students.view'] }), need).c)).toThrow(ForbiddenException);
    const ok = guardFor(user({ permissions: ['students.view', 'students.update'] }), need);
    expect(ok.guard.canActivate(ok.c)).toBe(true);
  });

  it('confines sessions awaiting MFA enrolment to MFA-setup routes, even with permissions', () => {
    const pending = user({ mfaSetupRequired: true, permissions: ['users.manage'] });
    const blocked = guardFor(pending, { [PERMISSIONS_KEY]: ['users.manage'] });
    expect(() => blocked.guard.canActivate(blocked.c)).toThrow(/Enable multi-factor/);
    const setup = guardFor(pending, { [ALLOW_MFA_SETUP]: true });
    expect(setup.guard.canActivate(setup.c)).toBe(true);
  });
});
