import {
  BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { randomUUID } from 'node:crypto';
import { MFA_REQUIRED_ROLES } from '@kiu/shared';
import { decryptSecret, encryptSecret, randomHex, randomToken, sha256Hex } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { RECOVERY_CODE_COUNT, RESET_TOKEN_TTL_MINUTES, passwordPolicyError } from './auth.constants';

authenticator.options = { window: 1 };

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const GENERIC_LOGIN_ERROR = { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };

export interface LoginInput {
  email: string;
  password: string;
  mfaCode?: string | undefined;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  mfaSetupRequired: boolean;
  user: { id: string; email: string; displayName: string; userType: string; roles: string[] };
}

type UserWithRoles = User & { roles: { role: { code: string } }[] };

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  private dummyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.dummyHash = argon2.hash('timing-equaliser-not-a-real-password', ARGON_OPTS);
  }

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTS);
  }

  // ───────────────────────── login ─────────────────────────

  async login(input: LoginInput, meta: RequestMeta): Promise<IssuedSession> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });

    if (!user) {
      await argon2.verify(await this.dummyHash, input.password).catch(() => false); // equalise timing
      await this.audit.record({ actorType: 'SYSTEM', action: 'auth.login_failed', entityType: 'User', entityId: null, reason: 'unknown_email', requestMeta: meta });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({ actorId: user.id, action: 'auth.login_blocked_locked', entityType: 'User', entityId: user.id, requestMeta: meta });
      throw new HttpException({ code: 'ACCOUNT_LOCKED', message: 'Account temporarily locked. Try again later or reset your password.' }, 423);
    }

    const passwordOk = await argon2.verify(user.passwordHash, input.password).catch(() => false);
    if (!passwordOk) {
      await this.registerFailure(user, meta, 'bad_password');
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    if (user.status !== 'ACTIVE' && user.status !== 'LOCKED') {
      await this.audit.record({ actorId: user.id, action: 'auth.login_blocked_status', entityType: 'User', entityId: user.id, reason: user.status, requestMeta: meta });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Multi-factor code required' });
      }
      const mfaOk = await this.verifyMfa(user, input.mfaCode, meta);
      if (!mfaOk) {
        await this.registerFailure(user, meta, 'bad_mfa');
        throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Invalid multi-factor code' });
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), ...(user.status === 'LOCKED' ? { status: 'ACTIVE' } : {}) },
    });
    const issued = await this.issueSession(user, undefined, meta);
    await this.audit.record({ actorId: user.id, action: 'auth.login_success', entityType: 'User', entityId: user.id, requestMeta: meta });
    return issued;
  }

  private async registerFailure(user: User, meta: RequestMeta, reason: string): Promise<void> {
    const failed = user.failedLogins + 1;
    const lock = failed >= this.env.LOGIN_MAX_FAILURES;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: failed, ...(lock ? { lockedUntil: new Date(Date.now() + this.env.LOGIN_LOCK_MINUTES * 60_000), failedLogins: 0 } : {}) },
    });
    await this.audit.record({ actorId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', entityType: 'User', entityId: user.id, reason, requestMeta: meta });
  }

  private async verifyMfa(user: User, code: string, meta: RequestMeta): Promise<boolean> {
    const clean = code.trim();
    if (/^\d{6}$/.test(clean) && user.mfaSecretEnc) {
      const secret = decryptSecret(user.mfaSecretEnc, this.env.DATA_ENCRYPTION_KEY, `user:${user.id}`);
      return authenticator.check(clean, secret);
    }
    // Single-use recovery code.
    const hash = sha256Hex(clean.toLowerCase());
    if (user.mfaRecoveryHashes.includes(hash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((h) => h !== hash) },
      });
      await this.audit.record({ actorId: user.id, action: 'auth.mfa_recovery_code_used', entityType: 'User', entityId: user.id, requestMeta: meta });
      return true;
    }
    return false;
  }

  // ───────────────────────── student self-registration ─────────────────────────

  /**
   * A student claims the first sign-in for a Student record Registry already created (by import or
   * admin entry). Registration never invents a Student identity — it only attaches a password to one
   * that already exists and has no login yet, so eligibility/access stay tied to real enrolment data.
   */
  async registerStudent(input: { regNo: string; email: string; password: string }, meta: RequestMeta): Promise<IssuedSession> {
    const regNo = input.regNo.trim().toUpperCase();
    const email = input.email.trim().toLowerCase();
    const noMatch = () => new BadRequestException({
      code: 'REGISTRATION_FAILED',
      message: 'Could not match those details to a student record. Contact Registry if you believe this is an error.',
    });

    const student = await this.prisma.student.findFirst({ where: { regNo, deletedAt: null }, include: { user: true } });
    if (!student || student.accountStatus !== 'ACTIVE') throw noMatch();
    if (student.user) throw new ConflictException({ code: 'ACCOUNT_EXISTS', message: 'An account already exists for this student. Sign in, or use "forgot password".' });
    if (student.email && student.email.toLowerCase() !== email) throw noMatch();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException({ code: 'EMAIL_IN_USE', message: 'That email address is already in use' });
    this.assertPolicy(input.password, email);

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: 'STUDENT' } });
    const passwordHash = await this.hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, displayName: student.fullName, userType: 'STUDENT', studentId: student.id, passwordHash },
      });
      await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      if (!student.email) await tx.student.update({ where: { id: student.id }, data: { email } });
      await this.audit.record({ actorId: created.id, action: 'auth.student_registered', entityType: 'User', entityId: created.id, after: { regNo }, requestMeta: meta }, tx);
      const full = await tx.user.findUniqueOrThrow({ where: { id: created.id }, include: { roles: { include: { role: true } } } });
      return this.issueSession(full, undefined, meta, tx);
    });
  }

  // ───────────────────────── sessions ─────────────────────────

  private async issueSession(user: UserWithRoles, familyId: string | undefined, meta: RequestMeta, tx?: Prisma.TransactionClient): Promise<IssuedSession> {
    const db = tx ?? this.prisma;
    const refreshToken = randomToken(48);
    const session = await db.session.create({
      data: {
        userId: user.id,
        familyId: familyId ?? randomUUID(),
        tokenHash: sha256Hex(refreshToken),
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ip: meta.ip ?? null,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, sid: session.id }, { expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS });
    const roles = user.roles.map((r) => r.role.code);
    return {
      accessToken,
      refreshToken,
      accessExpiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      mfaSetupRequired: !user.mfaEnabled && roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r)),
      user: { id: user.id, email: user.email, displayName: user.displayName, userType: user.userType, roles },
    };
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes the whole family. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedSession> {
    const tokenHash = sha256Hex(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    const invalid = new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Refresh token invalid or expired' });
    if (!session) throw invalid;

    if (session.rotatedAt || session.revokedAt) {
      // Token reuse: assume theft, burn the family.
      await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'refresh_reuse_detected' } });
      await this.audit.record({ actorId: session.userId, action: 'auth.refresh_reuse_detected', entityType: 'Session', entityId: session.id, requestMeta: meta });
      throw invalid;
    }
    if (session.expiresAt < new Date() || session.user.status !== 'ACTIVE') throw invalid;

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({ where: { id: session.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } });
      if (claimed.count !== 1) throw invalid; // lost a race: someone else rotated it
      return this.issueSession(session.user, session.familyId, meta, tx);
    });
  }

  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: user.sessionId } });
    if (session) {
      await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'logout' } });
    }
    await this.audit.record({ actorId: user.id, action: 'auth.logout', entityType: 'User', entityId: user.id, requestMeta: meta });
  }

  async revokeAllSessions(userId: string, reason: string, exceptSessionFamilyOf?: string): Promise<void> {
    let exceptFamily: string | undefined;
    if (exceptSessionFamilyOf) {
      exceptFamily = (await this.prisma.session.findUnique({ where: { id: exceptSessionFamilyOf } }))?.familyId;
    }
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptFamily ? { familyId: { not: exceptFamily } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  // ───────────────────────── profile ─────────────────────────

  async me(user: AuthUser) {
    const full = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { mfaEnabled: true, mustChangePassword: true, lastLoginAt: true, student: { select: { id: true, regNo: true, fullName: true } } },
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      userType: user.userType,
      roles: user.roles,
      permissions: user.permissions,
      mfaEnabled: full.mfaEnabled,
      mfaSetupRequired: user.mfaSetupRequired,
      mustChangePassword: full.mustChangePassword,
      lastLoginAt: full.lastLoginAt,
      student: full.student,
    };
  }

  // ───────────────────────── MFA ─────────────────────────

  async mfaSetup(user: AuthUser, meta: RequestMeta) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (row.mfaEnabled) throw new BadRequestException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled' });
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: encryptSecret(secret, this.env.DATA_ENCRYPTION_KEY, `user:${user.id}`) },
    });
    await this.audit.record({ actorId: user.id, action: 'auth.mfa_setup_started', entityType: 'User', entityId: user.id, requestMeta: meta });
    return { secret, otpauthUrl: authenticator.keyuri(row.email, 'KIU-USCAS', secret) };
  }

  async mfaEnable(user: AuthUser, code: string, meta: RequestMeta) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (row.mfaEnabled || !row.mfaSecretEnc) throw new BadRequestException({ code: 'MFA_SETUP_REQUIRED', message: 'Start MFA setup first' });
    const secret = decryptSecret(row.mfaSecretEnc, this.env.DATA_ENCRYPTION_KEY, `user:${user.id}`);
    if (!authenticator.check(code.trim(), secret)) throw new BadRequestException({ code: 'MFA_INVALID', message: 'Invalid code' });

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => `${randomHex(2)}-${randomHex(2)}-${randomHex(2)}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaRecoveryHashes: recoveryCodes.map((c) => sha256Hex(c)) } });
      await this.audit.record({ actorId: user.id, action: 'auth.mfa_enabled', entityType: 'User', entityId: user.id, requestMeta: meta }, tx);
    });
    return { recoveryCodes }; // shown exactly once
  }

  // ───────────────────────── password management ─────────────────────────

  async changePassword(user: AuthUser, current: string, next: string, meta: RequestMeta): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await argon2.verify(row.passwordHash, current).catch(() => false))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
    }
    this.assertPolicy(next, row.email);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await this.hashPassword(next), mustChangePassword: false } });
      await this.audit.record({ actorId: user.id, action: 'auth.password_changed', entityType: 'User', entityId: user.id, requestMeta: meta }, tx);
    });
    await this.revokeAllSessions(user.id, 'password_changed', user.sessionId);
  }

  async forgotPassword(emailRaw: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() } });
    // Same response and similar work either way: no account enumeration.
    if (!user || user.status === 'DISABLED') {
      await argon2.verify(await this.dummyHash, 'x').catch(() => false);
      return;
    }
    const token = randomToken(32);
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000) },
      });
      await this.audit.record({ actorId: user.id, action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id, requestMeta: meta }, tx);
    });
    await this.mail.send({
      to: user.email,
      subject: 'KIU-USCAS password reset',
      text: `Use this single-use code within ${RESET_TOKEN_TTL_MINUTES} minutes to reset your password: ${token}`,
    });
  }

  async resetPassword(token: string, next: string, meta: RequestMeta): Promise<void> {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
      throw new BadRequestException({ code: 'RESET_TOKEN_INVALID', message: 'Reset code is invalid or expired' });
    }
    this.assertPolicy(next, rec.user.email);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: rec.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException({ code: 'RESET_TOKEN_INVALID', message: 'Reset code is invalid or expired' });
      await tx.user.update({
        where: { id: rec.userId },
        data: { passwordHash: await this.hashPassword(next), failedLogins: 0, lockedUntil: null, mustChangePassword: false, ...(rec.user.status === 'LOCKED' ? { status: 'ACTIVE' } : {}) },
      });
      await this.audit.record({ actorId: rec.userId, action: 'auth.password_reset_completed', entityType: 'User', entityId: rec.userId, requestMeta: meta }, tx);
    });
    await this.revokeAllSessions(rec.userId, 'password_reset');
  }

  assertPolicy(password: string, email?: string): void {
    const err = passwordPolicyError(password, email ? { email } : {});
    if (err) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: err });
  }
}
