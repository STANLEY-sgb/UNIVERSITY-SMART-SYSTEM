# KIU-USCAS — Security Model

Prototype security design. **No claim of production certification, official KIU approval, hardware-grade card security or
approval for physical door control.** A browser-based virtual card is a *simulation* of the DESFire workflow, not a secure element.

## 1. Two separate concepts
* **Account authentication** — staff/student sign-in to web apps (Argon2id, JWT, MFA, RBAC).
* **Service-point authentication** — a card/QR/face presented to a registered reader (AES / Ed25519 / identity assertion, HMAC-signed requests).

## 2. Implemented controls (verified by automated tests)

| Control | Implementation | Test |
|---|---|---|
| Password storage | Argon2id (19 MiB, t=2, p=1); length-first policy (≥12, ≤128, blocklist, no email-name) | `auth.e2e`, `env.spec` |
| No user enumeration | identical error for bad password/unknown email; dummy-hash timing equaliser; forgot-password always 202 | `auth.e2e` |
| Lockout | 5 failures → 15 min (configurable), audited; reset-password clears | `auth.e2e` |
| Rate limiting | 120/min/IP; 10/min/IP on credential routes | `auth.e2e` |
| Sessions | 15-min JWT (HS256 pinned; `alg:none`/tamper rejected); session + permissions re-read per request; refresh rotation + family revocation on reuse; logout/disable/role-change/password-change revoke | `auth.e2e`, `rbac.e2e` |
| Cookies / CSRF | HttpOnly, SameSite, `Secure` (prod-enforced); refresh cookie path-scoped; double-submit CSRF on unsafe cookie requests | `auth.e2e` |
| MFA | TOTP, secret AES-256-GCM encrypted (AAD `user:<id>`), recovery codes hashed & single-use, enforced for privileged roles | `auth.e2e` |
| RBAC | server-side, deny-by-default, permission strings from one catalogue; students limited to `me.*` | `auth.guards.spec`, `rbac.e2e` |
| Privilege escalation | only Super Admin grants/modifies Super Admin; no self-modification; reasons required | `rbac.e2e` |
| Input validation | whitelist + forbid unknown, UUID/enum/length checks, 256 KB body limit | all e2e |
| Error hygiene | uniform error body; 5xx internals hidden; request IDs | `auth.e2e` |
| Security headers | helmet; API CSP `default-src 'none'`, `frame-ancestors 'none'` | — |
| Secrets at rest | AES-256-GCM envelopes with AAD; refresh/reset tokens SHA-256 only; audit redaction of credential-like keys | `security.spec`, `rbac.e2e`, `audit.e2e` |
| Audit | append-only trigger; SHA-256 hash chain; advisory-lock serialised; transactional with business change; verify endpoint detects tampering by a privileged actor | `audit.e2e` |
| DB integrity | one-ACTIVE-card, unique duplicates, CHECKs, immutable access logs | `db-constraints.e2e` |
| Config safety | env validated on boot; production refuses insecure cookies/placeholder secrets/demo seed | `env.spec` |

### 2b. Implemented in Phases 3–4 (verified by `access.e2e`, `cards.e2e`, `tap.e2e`, `simulator.e2e`, `throttle.e2e`, package specs)

| Control | Implementation |
|---|---|
| Reader device authentication | per-reader HMAC-SHA256 over method, URL, timestamp (±60 s), single-use nonce (5 min), body hash; secret shown once, AES-GCM at rest; rotation and revocation take effect immediately; alerts on bad HMAC, replay, revoked reader |
| Client can never assert identity | `/access/verify` rejects unknown fields; the student is resolved only from an authenticated credential |
| QR credential | Ed25519, `KIU1.payload.sig`, exp = iat + 30 s (±5 s skew), single-use nonce, strictly increasing counter shared with AES reads; validated against every key the card ever had so a revoked credential is recognised as such |
| AES virtual card | `Kc = AES-CMAC(master, UID‖AID)` (RFC 4493 vectors pass); three-pass mutual authentication; session keys `Kenc/Kmac`; encrypt-then-MAC card-number read (MAC verified before decrypt); fresh challenges; one attempt and one spend per session; unknown UIDs indistinguishable; the master key never leaves the server (SAM role) |
| Copied UID / wrong key | fails at mutual auth, logged as DENY, `COPIED_UID_WRONG_KEY` alert |
| Wallet activation | one-time 12-char code (hash only, 72 h), bound to the student, device generates its own Ed25519 key and proves possession; the server never holds a QR private key; a new phone revokes the old key |
| Lost card is final | credentials revoked, revocation version bumped, never reactivated; replacement gets new UID/number/keys; presenting the old one raises a HIGH alert |
| Rules | pure data, schema-validated, depth/size-limited, prototype-pollution paths rejected, unknown facts deny (also through `not`/`any`) |
| Throttling | people 120/min/IP, credentials 10/min/IP, readers 600/min per reader key with a 6 000/min/IP ceiling (so a campus NAT is not throttled and spoofed key ids still are) |
| Fail closed | any exception in the decision path becomes a logged DENY `SYSTEM_ERROR` |

**Residual risks (explicit):** the AES card key is delivered to the wallet at activation, and a browser/phone app is not a secure element, so a compromised device can clone the *virtual* card until it is reported lost; the QR is only as strong as the device's key custody; our CMAC sits on the platform AES block (vector-verified, but a vetted library/HSM is preferable); the master key is an environment variable in the prototype (KMS/HSM + rotation plan needed); throttler state is per-process.

### 2c. Implemented in Phase 5 (verified by `engine.spec`, `offline.e2e`, and the Playwright suite)

| Control | Implementation |
|---|---|
| Signed offline list | Ed25519-signed manifest (`CACHE_SIGNING_KEY`); the reader **pins the signer** on first contact and rejects other signers, wrong reader/service, expired lists and **older versions** (rollback would hide newer revocations); the stored manifest is re-verified on every use (tamper test) |
| Offline policy | only `CACHED_ALLOW` services (GATE) get cards; every other service gets `DENY_ALL` and the reader refuses everything offline (exam hall tested in a browser); AES keys never leave the server, so tap is online-only |
| Offline replay | nonces and per-card counters persisted in IndexedDB; reconciliation raises the server counter so an offline-accepted QR cannot be replayed online |
| Reconciliation | idempotent by batch key and entry key; stale-cache grants after a revocation are flagged and alert HIGH; batch keys are bound to the uploading reader; timestamps outside −7 d / +5 min rejected |
| Wallet key | Ed25519 generated with WebCrypto as **non-extractable**, stored as a CryptoKey in IndexedDB; only the public key + proof of possession go to the server; the AES card key returned at activation is discarded by the browser wallet |
| Reader secret | imported as a **non-extractable** HMAC CryptoKey; plaintext never stored (tested); browser HMAC verified byte-for-byte against the server implementation |
| Cookie sessions | HttpOnly cookies, double-submit CSRF header, transparent refresh with rotation; student-only gate in the wallet |
| Student data | `/me/*` endpoints return only the caller's records; eligibility and history verified not to leak other students |
| Accessibility as a safety property | status always icon + words; AA contrast enforced by a token-level test (incl. the gradient axe cannot evaluate); 44 px targets and reduced motion checked at six widths |

**Residual risks (explicit):** the wallet and reader keys are software-backed (non-extractable, but a compromised page can still *ask* them to sign — hence per-reader revocation and throttling); an isolated reader cannot learn of revocations after its last sync (bounded by the 30-minute list life and the stale-grant alert); signer pinning is trust-on-first-use over the reader's authenticated channel; camera scanning is not covered by an automated test; the offline path can double-log one scan if a request times out after the server already processed it.

### 2d. Implemented in Phase 6 — admin console (verified by `admin-api.e2e`, `admin.spec`, `admin-responsive.spec`)

| Control | Implementation |
|---|---|
| Forced MFA enrolment | un-enrolled privileged accounts see only the enrolment screen (no navigation reachable), must prove a TOTP code, and are shown single-use recovery codes once; later sign-ins demand a code |
| Navigation is cosmetic, the API is the control | menu items follow permissions, but every endpoint independently enforces them (a role without `students.view` gets a refusal page *and* 403s from the API) |
| Minimum data per role | dashboard and student overview return only the sections a role may see (finance facts to finance/registry roles, cards to the card office, access history to log viewers) |
| One-time secrets | activation codes and reader secrets are shown once in a dialog and never kept by the console; copy buttons only |
| Audited reasons | block, unblock, lost, replace, revoke, suspend, rollback and alert acknowledgement require a written reason (5+ chars), recorded in the hash-chained audit trail |
| No way back from LOST / REVOKED | the UI offers no unblock for a lost card and no re-enable for a revoked reader (the API refuses too) |
| Escalation guard in the UI | a non-super-admin is never offered the Super Administrator role when adding staff (the API also refuses) |
| Tamper evidence | the audit page runs the server-side hash-chain verification and reports the first broken entry |
| Accessible dialogs | focus moves in, is trapped, Escape closes, focus returns to the opener |

**Residual risks (explicit):** MFA secret entry is manual (no QR rendering yet); the console trusts the API's session cookies (HttpOnly + CSRF) but has no content-security-policy of its own beyond what the host serves; there is no per-action step-up re-authentication for destructive actions.

## 3. Designed, not yet implemented (by phase)

* **P3/P4 leftovers** key rotation procedure for the card master key, revocation deny-list endpoint (`CardRevocation.version` is recorded but not yet served to readers).
* **P5** Signed offline manifests, local verification, idempotent log upload.
* **P6** Biometric service boundary, signed assertions, encrypted templates, consent & deletion.
* **P8** MQTT per-reader ACLs; `reader/cmd` cannot unlock arbitrary devices without an approved, audited policy.
* **P9** CSP for web apps, dependency audit, SAST, fuzzing of protocol messages, k6 load, accessibility.

## 4. Threat model (summary)

| Threat | Mitigation |
|---|---|
| Screenshot/replay of QR | 30-s expiry, nonce + counter replay state. *Cannot* be made impossible; only short-lived. |
| Copied UID | UID never authenticates; requires AES proof |
| Cloned/lost card | status + revocation list + reader deny-list push; alert on reuse |
| Rogue/stolen reader | per-reader HMAC secret, service/venue binding, revocation, heartbeat monitoring |
| Captured request replay | timestamp window + nonce store |
| Token theft | short TTL, HttpOnly cookies, rotation + reuse detection, server-side revocation |
| Insider abuse | least privilege, mandatory reasons, hash-chained audit, escalation blocks |
| DB admin tampering | detectable via chain verification; external anchoring planned |
| Face spoofing | maintained liveness SDK (never home-made), online-only, no accuracy claims without evidence |
| Isolated reader & revocation | **Unavoidable**: a disconnected reader cannot learn of later revocations; bounded by short cache validity, revocation versioning and per-service offline policy |

## 5. Privacy
Minimisation (readers get name/photo-ref only where needed; health shows no clinical data), role-scoped data, retention controls (placeholders pending KIU policy), purpose transparency; Uganda Data Protection and Privacy Act, 2019. Biometrics: see [BIOMETRIC_PRIVACY.md](BIOMETRIC_PRIVACY.md).

## 6. Known limitations (current)
No TLS termination in dev (use a proxy in deployment); throttler storage is in-process (single instance) until Redis is wired; dev mail adapter prints, does not send; JWT is symmetric HS256 (fine for one API; move to asymmetric if multiple verifiers); audit-chain external anchoring pending.
