export const ACCESS_COOKIE = 'kiu_at';
export const REFRESH_COOKIE = 'kiu_rt';
export const CSRF_COOKIE = 'kiu_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const RESET_TOKEN_TTL_MINUTES = 30;
export const RECOVERY_CODE_COUNT = 8;

const COMMON_PASSWORDS = new Set([
  'password1234', 'passw0rd1234', 'qwertyuiop12', '123456789012', 'welcome12345', 'letmein12345', 'iloveyou1234',
]);

/** Length-first password policy (NIST 800-63B style). Returns an error message or null. */
export function passwordPolicyError(password: string, context: { email?: string } = {}): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Password is too common';
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'Password must not contain your email name';
  if (new Set(password).size < 5) return 'Password is too repetitive';
  return null;
}
