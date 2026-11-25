import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { randomToken } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { AllowMfaSetup, AuthUser, Authenticated, CurrentUser, Public, ReqMeta, RequestMeta } from '../../common/decorators';
import { AuthService, IssuedSession } from './auth.service';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, MfaEnableDto, RefreshDto, RegisterStudentDto, ResetPasswordDto } from './auth.dto';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(ENV) private readonly env: Env) {}

  private cookieBase(): CookieOptions {
    return { httpOnly: true, secure: this.env.COOKIE_SECURE, sameSite: 'lax' };
  }

  private setCookies(res: Response, s: IssuedSession): void {
    const refreshMaxAge = this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;
    res.cookie(ACCESS_COOKIE, s.accessToken, { ...this.cookieBase(), path: '/', maxAge: s.accessExpiresIn * 1000 });
    res.cookie(REFRESH_COOKIE, s.refreshToken, { ...this.cookieBase(), sameSite: 'strict', path: REFRESH_COOKIE_PATH, maxAge: refreshMaxAge });
    // Double-submit CSRF token: readable by the app's JS on purpose, echoed in X-CSRF-Token.
    res.cookie(CSRF_COOKIE, randomToken(24), { httpOnly: false, secure: this.env.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: refreshMaxAge });
  }

  private clearCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { ...this.cookieBase(), path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieBase(), sameSite: 'strict', path: REFRESH_COOKIE_PATH });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  private body(s: IssuedSession, includeTokens: boolean) {
    return {
      user: s.user,
      mfaSetupRequired: s.mfaSetupRequired,
      accessTokenExpiresIn: s.accessExpiresIn,
      ...(includeTokens ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : {}),
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in. Browsers receive HttpOnly cookies; send `X-Token-Delivery: body` to also receive tokens in the body (non-browser clients).' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ReqMeta() meta: RequestMeta) {
    const session = await this.auth.login(dto, meta);
    this.setCookies(res, session);
    return this.body(session, req.headers['x-token-delivery'] === 'body');
  }

  @Public()
  @Post('register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Student self-registration: claims the first sign-in for a student record Registry already created.' })
  async register(@Body() dto: RegisterStudentDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ReqMeta() meta: RequestMeta) {
    const session = await this.auth.registerStudent(dto, meta);
    this.setCookies(res, session);
    return this.body(session, req.headers['x-token-delivery'] === 'body');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token (cookie, or body for non-browser clients).' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ReqMeta() meta: RequestMeta) {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const token = dto.refreshToken ?? fromCookie;
    if (!token) throw new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Refresh token missing' });
    // Tokens only ever come back in the body when the client itself supplied one in the body,
    // so a script that can merely trigger a cookie-based refresh can never read the new tokens.
    const bodyMode = dto.refreshToken !== undefined;
    const session = await this.auth.refresh(token, meta);
    this.setCookies(res, session);
    return this.body(session, bodyMode);
  }

  @Authenticated() @AllowMfaSetup()
  @ApiBearerAuth() @ApiCookieAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response, @ReqMeta() meta: RequestMeta): Promise<void> {
    await this.auth.logout(user, meta);
    this.clearCookies(res);
  }

  @Authenticated() @AllowMfaSetup()
  @ApiBearerAuth() @ApiCookieAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto, @ReqMeta() meta: RequestMeta) {
    await this.auth.forgotPassword(dto.email, meta);
    return { message: 'If the account exists, a reset code has been sent.' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  async reset(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword, meta);
  }

  @Authenticated()
  @ApiBearerAuth() @ApiCookieAuth()
  @Post('change-password')
  @HttpCode(204)
  async change(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @ReqMeta() meta: RequestMeta): Promise<void> {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword, meta);
  }

  @AllowMfaSetup()
  @ApiBearerAuth() @ApiCookieAuth()
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.auth.mfaSetup(user, meta);
  }

  @AllowMfaSetup()
  @ApiBearerAuth() @ApiCookieAuth()
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@CurrentUser() user: AuthUser, @Body() dto: MfaEnableDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.mfaEnable(user, dto.code, meta);
  }
}
