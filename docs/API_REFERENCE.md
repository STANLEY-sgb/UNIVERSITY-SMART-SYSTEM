# KIU-USCAS — API Specification

Base path `/api/v1`. Live OpenAPI/Swagger (non-production): `http://localhost:4000/api/docs`.
Status: ✅ implemented & tested · 🟡 planned (phase).

## Conventions

* **Auth**: browsers use HttpOnly cookies (`kiu_at`, `kiu_rt` scoped to `/api/v1/auth`) + double-submit CSRF (`kiu_csrf` cookie echoed in `X-CSRF-Token` on non-GET). Non-browser clients send `X-Token-Delivery: body` on login and use `Authorization: Bearer`.
* **Errors** (every failure): `{ statusCode, code, message, details?, requestId, timestamp }`. 5xx never leak internals. `X-Request-Id` is echoed.
* **Pagination**: `?page=1&pageSize=25` (max 100) → `{ data: [], meta: { page, pageSize, total, totalPages } }`.
* **Validation**: whitelist + forbid unknown fields → `400 BAD_REQUEST`, `message: "Validation failed"`, `details[]`.
* **Authorisation**: every route declares `@Public`, `@Authenticated` or `@RequirePermissions(...)`; undeclared = 403. Permission codes: `packages/shared/src/permissions.ts`.
* **Rate limits**: 120 req/min/IP default; 10/min/IP on `login`, `refresh`, `forgot-password`, `reset-password` (`429 RATE_LIMITED`).
* **Reader/device requests** (Phase 3): `X-Reader-Key-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature = HMAC-SHA256(secret, method|path|ts|nonce|sha256(body))`.

## Auth ✅

| Method & path | Access | Notes |
|---|---|---|
| `POST /auth/login` | public | `{email,password,mfaCode?}`. 401 generic `INVALID_CREDENTIALS`; 423 `ACCOUNT_LOCKED`; 401 `MFA_REQUIRED`/`MFA_INVALID`. Response `mfaSetupRequired` for privileged roles without MFA. |
| `POST /auth/refresh` | public | Rotates. Reuse of a rotated token revokes the whole family. Tokens are returned in the body only if the client sent `refreshToken` in the body. |
| `POST /auth/logout` | authenticated | Revokes the session family. 204. |
| `GET /auth/me` | authenticated | Profile, roles, permissions, MFA state. |
| `POST /auth/forgot-password` | public | Always 202 (no enumeration). Dev mail adapter. |
| `POST /auth/reset-password` | public | Single-use 30-min token; revokes all sessions; clears lockout. |
| `POST /auth/change-password` | authenticated | Revokes other sessions. |
| `POST /auth/mfa/setup` · `POST /auth/mfa/enable` | MFA-setup allowed | TOTP; returns 8 single-use recovery codes once. |

## Administration ✅

| Method & path | Permission | Notes |
|---|---|---|
| `GET /users` · `GET /users/:id` | `users.view` | filters `q`, `role`, `userType` |
| `POST /users` | `users.manage` | policy-checked password; `mustChangePassword`; SUPER_ADMIN grant needs SUPER_ADMIN |
| `PATCH /users/:id` | `users.manage` | `reason` required for role/status change; no self-modification; revokes sessions |
| `GET /roles` · `GET /permissions` | `users.view` | |
| `GET /audit` | `audit.view` | filters `entityType`, `action`, `actorId` |
| `GET /audit/verify` | `audit.view` | recomputes hash chain → `{ok, checked, brokenAtSeq}` |
| `GET /health` | public | DB probe |

## Students ✅ (core)

| Method & path | Permission |
|---|---|
| `GET /students` (`q`, `programmeId`, `yearOfStudy`, `accountStatus`) | `students.view` |
| `GET /students/:id` | `students.view` |
| `POST /students` | `students.create` — facts start fail-closed |
| `PATCH /students/:regNo/status` | `students.update` — `reason` mandatory, audited before/after |
| `POST /students/import`, `GET /students/:id/eligibility`, `/access-history` | 🟡 P7/P8 |

## Access decision ✅ (QR route) · other credential types 🟡

| Method & path | Status / notes |
|---|---|
| `POST /access/verify` | ✅ Reader-HMAC authenticated. Body `{ credential:{type:"QR",token}, service?, direction?, context?:{examSessionId?,courseUnitCode?} }`. Unknown fields (e.g. a client-supplied `studentId`) → 400. Returns `{decision, reason_code, message, student:{reg_no,full_name,programme,photo_ref}\|null, log_id, decided_at, processing_ms}`. `student` is null unless the credential was authentic and the card ACTIVE (never for HEALTH). FACE_ASSERTION type 🟡 P6. `credential` is `{type:"QR",token}` **or** `{type:"TAP",sessionId,ivHex,ctHex,macHex}`. |
| `GET /logs` | ✅ `access.logs.view`; filters `decision, service, readerId, regNo, from, to`; safe fields only |
| `POST /readers` · `GET /readers` · `GET /readers/:id` | ✅ `readers.manage` / `readers.view`. Create returns `{reader, credentials:{keyId, secret}}` — **secret shown once** |
| `PATCH /readers/:id/status` | ✅ `ACTIVE\|DISABLED\|REVOKED` + reason; REVOKED also revokes credentials |
| `POST /readers/:id/rotate-credential` | ✅ old key revoked immediately |
| `POST /readers/heartbeat` | ✅ reader-HMAC (path differs from the PDF's `/readers/:id/heartbeat`; the reader is identified by its key) |
| `GET /readers/:id/allowlist` | ✅ reader-HMAC (`:id` must be the caller). Returns `{manifest, signature, signerPublicKeyHex}`: Ed25519-signed, versioned, valid `OFFLINE_CACHE_TTL_MINUTES` (30). `policy: CACHED_ALLOW` lists active cards (card number, QR public key(s), display name, expiry) + `revoked` card numbers; `DENY_ALL` services get an empty list so readers fail closed |
| `POST /readers/:id/logs` | ✅ reader-HMAC. `{batchKey, entries[≤500]}` (entry: `idempotencyKey, cardNumber, decision, reasonCode, occurredAt, direction?, counter, manifestVersion`). Idempotent by batch key and entry key; rejects timestamps >5 min in the future or >7 days old; raises the card counter; flags grants after a revocation (`OFFLINE_STALE_GRANT`, HIGH alert). Returns `{duplicate, accepted, duplicates, rejected, conflicts}` |
| `GET /access/live` (WS), `POST /overrides` | 🟡 P7/P8 |
| `GET /services/:code/rule` | ✅ `rules.view` → `{service, published, draft}` |
| `PUT /services/:code/rule` | ✅ `rules.manage` → saves a validated DRAFT (400 `RULE_INVALID` + `details[]`) |
| `POST /services/:code/rule/versions/:v/publish` | ✅ draft → published; previous archived; audited |
| `POST /services/:code/rule/versions/:v/rollback` | ✅ republishes an older definition as a new version; reason required |
| `GET /services/:code/rule/history` | ✅ |
| `POST /rules/test` | ✅ dry-run a definition against a real student's facts; writes nothing |
| `GET /me/eligibility` | ✅ `me.eligibility.view`. Per service: `status` (ELIGIBLE / NOT_ELIGIBLE / UNKNOWN / NOT_APPLICABLE / UNAVAILABLE), `reason_code`, `message`, `office`, optional `detail` (e.g. next exam). Same rules and evaluator as `/access/verify` (tested for parity) |
| `GET /me/access-history` · `GET /me/notifications` · `POST /me/notifications/read-all` | ✅ `me.view`; own records only |

**Reader request signing:** headers `X-Reader-Key-Id`, `X-Timestamp` (unix s, ±60 s), `X-Nonce` (16–64 chars, single use for 5 min), `X-Signature = hex(HMAC-SHA256(secret, METHOD "\n" URL "\n" ts "\n" nonce "\n" sha256(rawBody)))`. Helper: `signReaderRequest` in `@kiu/security`.
**Rate limits:** people 120/min/IP, credential routes 10/min/IP, readers 600/min per reader key (+ 6 000/min/IP ceiling for all reader traffic); all configurable (`THROTTLE_*`).
Device-level failures are HTTP errors (401 `READER_AUTH_REQUIRED/READER_UNKNOWN/BAD_HMAC/STALE_TIMESTAMP/BAD_NONCE`, 403 `READER_REVOKED`, 409 `NONCE_REPLAY`); everything after authentication is HTTP 200 with `decision`.

## Admin console support ✅

| Method & path | Permission | Notes |
|---|---|---|
| `GET /dashboard/summary` | `reports.view` | Live aggregates (students, cards by status, readers online = heartbeat < 2 min, today's grants/denies/offline/exam attendance, top denial reasons, by service, hourly traffic, open alerts). **Sections are permission-gated**: `recentDecisions` needs `access.logs.view`, `recentAdminActions` needs `audit.view` |
| `GET /alerts` | `alerts.view` | `state=open\|acknowledged\|all`, `severity`; paginated |
| `POST /alerts/:id/ack` | `alerts.manage` | `{note?}`; idempotent; audited |
| `GET /services` | `services.view` | code, name, offline policy, published version, draft flag, reader count |
| `GET /venues` | `readers.view` | for reader provisioning |
| `GET /students/:id/overview` | `students.view` | profile, enrolments, hostel, loans; **facts only with finance.view / registry.view / students.update; cards only with cards.view; recent access only with access.logs.view** |

## Cards ✅ (API) — wallet/officer UIs 🟡 Phase 5/6

| Method & path | Permission | Notes |
|---|---|---|
| `POST /cards` (alias `/cards/issue`) | `cards.issue` | `{regNo}` → PENDING card + `activationCode` (**shown once**, 72 h TTL, only its SHA-256 is stored). Student must be ACTIVE; 409 if they already hold an ACTIVE card; supersedes an unactivated card |
| `GET /cards` · `GET /cards/:id` · `GET /cards/:id/history` | `cards.view` | filters `regNo, status, q`; never returns UID, hashes or keys |
| `POST /cards/:id/block` · `POST /cards/:id/unblock` · `PATCH /cards/:id` `{status: BLOCKED\|ACTIVE, reason}` | `cards.block` | reason ≥ 5 chars; each bumps the revocation version, notifies the student, audited |
| `POST /cards/:id/report-lost` | `cards.block` | LOST is **final** (409 `LOST_CARD_FINAL` on unblock); revokes all credentials; idempotent |
| `POST /cards/:id/replace` | `cards.replace` | `{reason, feeStatus?}`; retires the old card, issues a new UID/number/keys; 409 `ALREADY_REPLACED` |
| `POST /cards/:id/reset-activation` | `cards.issue` | new code for a new phone; the previous device key is revoked on use |
| `GET /me/card` | `me.card.view` | the student's own card state only |
| `POST /me/card/activate` | `me.card.view` | `{code, devicePublicKeyHex, proofHex, deviceLabel?}`; `proofHex` = Ed25519 signature over `KIU-ACTIVATE:<cardNumber>`. Returns `{cardNumber, uidHex, aidHex, expiresAt, aesKeyHex}`. The device private key never leaves the device |
| `POST /me/card/report-lost` | `me.card.report_lost` | own current card only |
| `GET /me/card/qr` | — | **not provided by design**: QR tokens are signed on the device with its own key |

### Virtual-card tap (reader-HMAC authenticated)

1. Reader SELECTs the card → UID (card side, no API call).
2. `POST /access/tap/begin {uidHex}` → `{sessionId, rndR, expiresInMs: 30000}` (always answers, even for unknown UIDs, so UIDs cannot be enumerated).
3. Card computes `proofC = CMAC(Kc, 01‖RndR‖RndC)`; `POST /access/tap/auth {sessionId, rndCHex, proofHex}` → `{ok:true, proofRHex}` or `{ok:false, reason_code:"CREDENTIAL_INVALID"}`. **One attempt per session.** The card verifies `proofRHex` (mutual authentication) and derives session keys.
4. Card returns `iv`, `ct = AES-CBC(Kenc, cardNumber:counter)`, `mac = CMAC(Kmac, iv‖ct)`; reader calls `POST /access/verify` with `credential: {type:"TAP", sessionId, ivHex, ctHex, macHex}`. A session can be spent once.

`Kc = CMAC(master, UID‖AID)` is derived server-side (the SAM role); readers never hold the master key.

## Biometrics 🟡 Phase 6 (opt-in, online-only)

`POST /biometrics/enroll/start` · `POST /biometrics/enroll/complete` · `GET /me/biometrics` · `POST /biometrics/revoke` · `DELETE /biometrics/enrollments/:id` · `GET /biometrics/policies` · `POST /readers/:id/face/verify` (1:1) · `POST /readers/:id/face/identify` (1:N, feature-flagged, default off). Responses never contain templates, embeddings, raw captures or scores on reader-facing endpoints.

## University services ✅ (Finance, Registry, Library) · Phase 7
Every write needs a `reason` where noted, is audited with before/after, bumps the student's `factsVersion`, and takes effect on the **next** access decision (facts are read live).

| Method & path | Permission | Notes |
|---|---|---|
| `GET /finance/students` | `finance.view` | `q`, `clearance=cleared\|pending`; paginated |
| `PATCH /finance/students/:regNo` | `finance.update` | `{feesPaidPercent?, examCleared?, reason}` (≥1 field; 0–100); notifies the student when clearance changes |
| `PATCH /registry/students/:regNo/registration` | `registry.manage` | `{semesterRegistered, reason}` |
| `GET /library/loans` | `library.view` | `regNo`, `status=ACTIVE\|OVERDUE\|RETURNED`; paginated |
| `POST /library/loans` | `library.manage` | `{regNo, itemRef, title, days?}`; re-checks `LIBRARY_BORROW` eligibility first (409 with the rule's reason code) |
| `POST /library/loans/:id/return` | `library.manage` | recomputes overdue count; 409 if already returned |
| `PATCH /library/students/:regNo/fines` | `library.manage` | `{fineUgx, reason}` |

| `GET /hostels` · `GET /hostels/allocations` | `hostel.view` | residents per hostel; active allocations (`hostel`, `regNo` filters) |
| `POST /hostels/allocations` | `hostel.manage` | `{regNo, hostelCode, roomNo?, reason}`; replaces the student's current allocation |
| `POST /hostels/allocations/:id/end` | `hostel.manage` | `{reason}`; 409 if already ended |
| `GET /cafeteria/sittings` | `cafeteria.view` | |
| `PATCH /cafeteria/sittings/:id` | `cafeteria.manage` | `{startsAt, endsAt, reason}` HH:MM; 409 if backwards or overlapping another sitting |
| `GET /lectures` | `registry.view` | |
| `POST /lectures` | `registry.manage` | `{courseCode, venueCode, dayOfWeek 0–6, startsAt, endsAt}`; 409 on a room clash |
| `POST /lectures/:id/remove` | `registry.manage` | `{reason}`; 409 if attendance was recorded |

| `POST /imports/preview` | domain permission (`finance.update` / `registry.manage` / `library.manage` for the `kind`) | `{kind: FINANCE\|REGISTRY\|LIBRARY, csv}` → `{sha256, summary, alreadyImported, rows[≤200]}`; changes nothing |
| `POST /imports/commit` | same | `{kind, csv, reason, expectedSha256}`; 409 `FILE_CHANGED` / `DUPLICATE_IMPORT` / `NOTHING_TO_APPLY`; atomic; audited per row |
| `GET /imports/jobs` | `integrations.view` | paginated CSV import history |

| `GET /reports/access` | `reports.view` | `?from&to` (YYYY-MM-DD, ≤93 days) → totals, byDay, byService, byReader, topDenialReasons, byMethod |
| `GET /reports/access/export` | `reports.export` + `access.logs.view` | CSV download (≤10,000 rows, audited, formula-safe) |

| `GET /exams/sessions`, `GET /exams/halls` | `exams.view` | paged exam sessions (`when`), exam halls |
| `POST /exams/sessions` | `exams.manage` | `{courseCode, venueCode, startsAt, endsAt, entryOpensMinutesBefore?, entryClosesMinutesAfter?, reason}`; 409 `VENUE_CLASH` / `ALREADY_SCHEDULED` / `NOT_EXAM_HALL` / `INVALID_WINDOW` |
| `POST /exams/sessions/:id/cancel` | `exams.manage` | `{reason}`; 409 `HAS_ATTENDANCE` |
| `GET /exams/sessions/:id/attendance` | `exams.attendance.view` | paged attendance |

| `POST /access/verify` with `credential: {type: "FACE", regNo, frames}` | reader HMAC | 1:1 prototype face verification; `FACE_*` reason codes; `frames` = 3–8 arrays of 576 luminance values (24×24) |
| `GET /biometrics/notice`, `POST /biometrics/enrollments` | `biometrics.enroll` | `{regNo, noticeVersion, consentConfirmed, frames}`; 409 `NOTICE_OUTDATED` / `ALREADY_ENROLLED` / `CONSENT_REQUIRED`; 422 `FACE_QUALITY_FAILED` / `FACE_LIVENESS_FAILED` |
| `GET /biometrics/enrollments` | `biometrics.view` | paged, never includes templates |
| `POST /biometrics/enrollments/:id/revoke` | `biometrics.revoke` | `{reason}`; deletes the template |
| `GET /biometrics/policy`, `PUT /biometrics/policy` | `biometrics.view` / `biometrics.policy.manage` | `{matchThreshold?, faceEnabled?, reason}` |
| `GET /biometrics/devices`, `PUT /biometrics/devices/:readerId` | `biometrics.view` / `biometrics.policy.manage` | per-reader face authorisation |
| `GET /me/biometrics`, `POST /me/biometrics/withdraw` | `me.biometrics.manage` | student self-service |

| `GET|PATCH /settings/policy` | `settings.manage` | policy values (`fine_limit_ugx`, `exam_min_fees_percent`, `gate_direction_required`) + `reason` |
| `GET|POST /settings/venues`, `PATCH /settings/venues/:code` | `settings.manage` | venue management |
| `GET|POST /settings/sessions`, `POST /settings/sessions/:id/semesters`, `POST /settings/semesters/:id/make-current` | `settings.manage` | academic calendar; 409 `INVALID_DATES` / `OUTSIDE_SESSION` / `SEMESTER_OVERLAP` / `ALREADY_CURRENT` |
| `POST /access/overrides` | `access.override` | `{regNo, serviceCode, readerCode?, reason≥10}`; 409 `NO_RECENT_DENIAL` / `NOT_OVERRIDABLE` / `ALREADY_OVERRIDDEN` |
| `GET /access/overrides` | `access.logs.view` | paged override history |
| `GET /programmes` | `students.view` | programme list for the registration form |

| `GET /events` | `reports.view` | server-sent events: `decision`, `alert`, `ping`; no personal data |
| `GET /exams/sessions/:id/seats` | `exams.view` | seating summary and list |
| `POST /exams/sessions/:id/seats/auto-assign` | `exams.manage` | `{reason}`; 409 `NOTHING_TO_ASSIGN` / `OVER_CAPACITY` |
| `POST /exams/sessions/:id/seats` | `exams.manage` | `{regNo, seatLabel, reason}`; 409 `SEAT_TAKEN` / `NOT_ENROLLED` |

| `GET /reports/catalog` | any signed-in user | the reports this user may run |
| `GET /reports/domain/:kind` | the report's data permission (CSV also `reports.export`) | kinds: `exam-attendance`, `finance-clearance`, `library-overdue`, `meals-served`, `hostel-occupancy`; `?from&to&format=csv` |

| `GET /biometrics/pending` | `biometrics.view` | `{summary: {required, enforceFrom, enforced, students, enrolled, exempt, pending}, data[], meta}` |
| `POST /biometrics/exemptions`, `POST /biometrics/exemptions/revoke` | `biometrics.policy.manage` | `{regNo, reason≥10}`; 409 `ALREADY_EXEMPT`, 404 `NO_EXEMPTION` |
| `PUT /biometrics/policy` | `biometrics.policy.manage` | now also `enrolmentRequired`, `enforceFrom` (`YYYY-MM-DD` or `null`) |
| access reason `FACE_ENROLMENT_REQUIRED` | n/a | returned by `/access/verify` for QR/tap once enforcement has started |

Service behaviour in `POST /access/verify` (any credential): **GATE/hostel-type services** with `requiresDirection` apply anti-passback (`ANTI_PASSBACK`, or `DIRECTION_REQUIRED` when policy demands a direction; D-035). **CAFETERIA** needs a live meal sitting (`OUTSIDE_TIME_WINDOW`) and serves once per sitting per day (`MEAL_ALREADY_CLAIMED`). **LECTURE** needs a timetabled lecture in the reader's room now and records attendance once per day. **HOSTEL** compares the student's allocation with the reader's hostel.

## Operations 🟡 Phase 8

Finance (`/finance/...`), registry, library (`/library/loans`, `/returns`), hostels, cafeteria, attendance, exam sessions, integrations (`/integrations/jobs`, CSV import with preview/validate/commit), notifications, reports (`GET /reports/exam-attendance` + CSV/PDF export), security alerts, readers CRUD, venues. MQTT topics: `kiu/access/request/{reader_id}`, `kiu/access/response/{reader_id}`, `kiu/cache/{service}`, `kiu/reader/heartbeat/{reader_id}`, `kiu/reader/cmd/{reader_id}`.
