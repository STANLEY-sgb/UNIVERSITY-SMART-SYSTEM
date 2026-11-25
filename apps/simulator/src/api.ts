import { randomBytes } from 'node:crypto';
import { signReaderRequest } from '@kiu/security';

export interface ApiResponse { status: number; body: any }

/** Minimal transport so the same simulator runs over fetch (CLI) or supertest (tests). Always the REAL API. */
export interface ApiTransport {
  request(method: string, path: string, opts?: { bodyText?: string; headers?: Record<string, string> }): Promise<ApiResponse>;
}

export class ApiClient {
  constructor(readonly transport: ApiTransport, readonly prefix = '/api/v1') {}

  async call(method: string, path: string, body?: unknown, token?: string): Promise<ApiResponse> {
    return this.transport.request(method, `${this.prefix}${path}`, {
      ...(body !== undefined ? { bodyText: JSON.stringify(body) } : {}),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  }

  async login(email: string, password: string, mfaCode?: string): Promise<string> {
    const r = await this.transport.request('POST', `${this.prefix}/auth/login`, {
      bodyText: JSON.stringify({ email, password, ...(mfaCode ? { mfaCode } : {}) }),
      headers: { 'Content-Type': 'application/json', 'X-Token-Delivery': 'body' },
    });
    if (r.status !== 200 || !r.body.accessToken) throw new Error(`login failed for ${email}: ${r.status} ${r.body?.code ?? ''}`);
    return r.body.accessToken as string;
  }
}

export interface ReaderKey { keyId: string; secret: string }

export interface SignOverrides { nonce?: string; timestamp?: string; secret?: string; keyId?: string }

/** A reader device: signs every request with its HMAC secret (HMAC-SHA256 over method, URL, ts, nonce, body hash). */
export class ReaderClient {
  constructor(private readonly api: ApiClient, readonly key: ReaderKey) {}

  post(path: string, body: unknown, o: SignOverrides = {}): Promise<ApiResponse> {
    const url = `${this.api.prefix}${path}`;
    const bodyText = JSON.stringify(body);
    const ts = o.timestamp ?? String(Math.floor(Date.now() / 1000));
    const nonce = o.nonce ?? randomBytes(16).toString('hex');
    const sig = signReaderRequest(o.secret ?? this.key.secret, 'POST', url, ts, nonce, bodyText);
    return this.api.transport.request('POST', url, {
      bodyText,
      headers: { 'Content-Type': 'application/json', 'X-Reader-Key-Id': o.keyId ?? this.key.keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig },
    });
  }

  /** Signed GET (empty body), e.g. the offline allow-list. */
  get(path: string, o: SignOverrides = {}): Promise<ApiResponse> {
    const url = `${this.api.prefix}${path}`;
    const ts = o.timestamp ?? String(Math.floor(Date.now() / 1000));
    const nonce = o.nonce ?? randomBytes(16).toString('hex');
    const sig = signReaderRequest(o.secret ?? this.key.secret, 'GET', url, ts, nonce, '');
    return this.api.transport.request('GET', url, {
      headers: { 'X-Reader-Key-Id': o.keyId ?? this.key.keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig },
    });
  }

  verify(credential: unknown, extra: Record<string, unknown> = {}, o: SignOverrides = {}) {
    return this.post('/access/verify', { credential, ...extra }, o);
  }
}
