# KIU-USCAS — Requirements Traceability Matrix

> ⚠️ **FR-01…FR-14 / NFR-01…NFR-10 are PROVISIONAL.** The master prompts cite these IDs from the 41-page *KIU Unified Smart
> Card Access System — Project Documentation Guide* (a.k.a. "KIU SMARTER VIRTUAL CARD.pdf"), which is **not in the repository**.
> Titles below are reconstructed from the four reference PDFs in `docs/reference/`. When the source PDF is supplied, re-map each
> row (see [DECISIONS D-001](DECISIONS.md)). Test-case IDs TC-01…TC-10 and the PDF's section numbers are quoted by the prompts and used as-is.

**Status legend:** ⬜ not started · 🟨 partial · ✅ done & verified. A feature is ✅ only when data model, backend, frontend, authorisation, validation and tests are all integrated. **No FR is fully ✅ yet**: the backend core exists, UIs and most workflows do not.

## Functional requirements (provisional titles)

| ID | Requirement (derived) | Modules | Phase | Status | Tests | Evidence |
|---|---|---|---|---|---|---|
| FR-01 | Student identity & registry record (create, search, status) | `students`, `student_status`, Registry UI | 2/7 | 🟨 API list/get/create/status/overview ✅; **console: search, filter, paginate, detail with role-gated facts, issue card ✅**; create-student form, import ⬜ | `students.e2e.ts`, `admin-api.e2e.ts`, `admin.spec.ts` (browser) | PROGRESS.md |
| FR-02 | Virtual smart card issuance & lifecycle (one active card, block, lost, replace) | `cards`, `card_*` | 4 | 🟨 API ✅: issue, activate (device PoP), block/unblock, report-lost, replace, history, student self-report; DB one-active rule concurrency-tested; officer/student **UI ⬜** | `cards.e2e.ts`, `db-constraints.e2e.ts`, `simulator.e2e.ts` | PROGRESS.md |
| FR-03 | Card/credential authentication: AES-128 tap protocol, rotating Ed25519 QR, replay/counter | `packages/vcard`, `access` | 3/4 | 🟨 QR verify, nonce replay, shared counter ✅; AES-CMAC diversification + mutual-auth tap + encrypted read ✅ (RFC 4493 vectors); wallet **UI** ⬜ | `qr.spec.ts`, `cmac.spec.ts`, `tap.spec.ts`, `tap.e2e.ts`, `access.e2e.ts` | PROGRESS.md |
| FR-04 | Reader registration, device authentication, heartbeat, revocation | `readers`, `reader_*` | 3/5 | 🟨 provision/rotate/revoke, HMAC+nonce auth, heartbeat ✅; **reader web app ✅** (onboarding with non-extractable key, camera/manual scan, result UI, diagnostics); admin UI for readers and MQTT ⬜ | `access.e2e.ts`, `reader.spec.ts` (browser) | PROGRESS.md |
| FR-05 | Central access verification API & decision pipeline | `access` | 3 | 🟨 `POST /access/verify` for QR **and TAP** ✅ (shared pipeline); FACE, anti-passback, other side-effects ⬜ | `access.e2e.ts` (30+ cases) | PROGRESS.md |
| FR-06 | Configurable, versioned JSON eligibility rules engine (no eval) | `packages/rules-engine`, `rules` | 3 | 🟨 engine + versioning/publish/rollback/test API ✅ (96 cases); rules editor UI ⬜ | `rules-engine.spec.ts`, `access.e2e.ts` | PROGRESS.md |
| FR-07 | University service workflows: gate (+anti-passback), library, exam, lecture, hostel, cafeteria, lab, health, sports/events/transport, graduation | service modules | 7 | 🟨 gate anti-passback, cafeteria (one per sitting), lecture attendance, hostel allocation, meal-window and timetable management, library loans/returns ✅ with tests and console pages; lab, health, sports/events/transport, graduation ⬜ | | |
| FR-08 | Integrations: Finance / Registry / Library / Hostel via CSV/Excel + mock API; invalidate facts → recalc → publish reader cache | `integrations`, `sync_jobs` | 8 | 🟨 CSV and Excel (.xlsx, converted in the browser) import (preview → commit, idempotent, audited) for Finance / Registry / Library ✅; mock HTTP API, scheduled sync, offline-list republish ⬜ | | |
| FR-09 | Access logging, tamper-evident audit trail, reports | `audit`, `access_logs`, `reports` | 2/8 | 🟨 audit ✅ (hash chain, append-only trigger) with **console view + integrity check**; **access-log viewer with filters** ✅; reports/exports (CSV/PDF) ⬜ | `audit.e2e.ts`, `admin.spec.ts` | PROGRESS.md |
| FR-10 | Offline reader operation with signed caches & idempotent reconciliation | `@kiu/offline-core`, `offline.service`, reader PWA | 5 | 🟨 ✅ signed manifest + pinned signer + rollback refusal, local decisions, IndexedDB queue, idempotent reconciliation, stale-grant alert, DENY_ALL fail-closed; ⬜ offline for non-gate services (by policy), offline face (by design) | `engine.spec.ts` (20), `offline.e2e.ts` (12), `reader.spec.ts` (TC-07 in browser) | PROGRESS.md |
| FR-11 | Administration dashboard (22 modules per prompt §17) | `apps/admin` | 6 | 🟨 **9 of 22 modules working with real data and actions**: overview (live), students, cards (issue/block/unblock/lost/replace/re-enrol), readers (provision/rotate/disable/revoke), rules (edit/test/publish/rollback), access logs, alerts (acknowledge), audit (verify), staff & roles; MFA enrolment. ⬜ venues, academic sessions, examinations, finance, library, hostel, cafeteria, overrides, integrations, reports, settings | `admin.spec.ts` (9), `admin-responsive.spec.ts` (4), `admin-api.e2e.ts` (8) | PROGRESS.md |
| FR-12 | Student portal & digital wallet with rotating QR, eligibility reasons, lost-card report | `apps/student-portal` | 5 | 🟨 ✅ login, activation (device key), ID card + rotating QR, My access with reasons/offices, history, notifications, report-lost, sign-out; ⬜ finance/registration/exam/library/hostel/meal detail pages, installability audit | `wallet.spec.ts` (browser + unit), `eligibility.e2e.ts` | PROGRESS.md |
| FR-13 | Real-time events & notifications (WebSocket, MQTT contracts, in-app notifications) | `events`, `notifications` | 8 | ⬜ | | |
| FR-14 | Overrides, security alerts, lost/cloned-card detection | `overrides`, `security_alerts` | 3/7 | 🟨 alerts for lost/blocked card, QR/request/tap replay, bad signature, copied-UID-wrong-key, counter regression, revoked reader ✅; **alert console with acknowledge ✅**; overrides ⬜ | `access.e2e.ts`, `admin-api.e2e.ts`, `admin.spec.ts` | |
| FR-AUTH* | Staff/student web auth: Argon2id, JWT+rotating refresh, MFA, RBAC, lockout, recovery *(prompt §4, not an FR id in the source)* | `auth`, `users` | 2 | ✅ API; ✅ **all 13 roles' console nav and API permission gates verified against a real login per role (session 7)** | `auth.e2e.ts`, `rbac.e2e.ts`, `auth.guards.spec.ts`, `role-matrix.spec.ts` | PROGRESS.md |

## Non-functional requirements (provisional titles; targets quoted from prompt §12)

| ID | Requirement | Phase | Status | Evidence plan |
|---|---|---|---|---|
| NFR-01 | Online tap-to-decision < 1 s | 9 | 🟨 **measured on one laptop** (`pnpm bench`, docs/PERFORMANCE.md): one reader p95 ≈ 27 ms, 10 at once p95 ≈ 70 ms, 50 at once p95 ≈ 394 ms / p99 ≈ 481 ms (loopback, client and server on the same machine, no TLS). Not proven for a real network, a separate database, or face | `e2e/bench.mjs` |
| NFR-02 | Offline decision < 300 ms | 9 | 🟨 **measured** for the decision logic: p95 2.7 ms over 200 decisions (Node); the browser UI shows tens of ms. Not yet measured on target hardware (tablet/phone) | on-device benchmark |
| NFR-03 | ≥ 20 students/min/reader; p95 server < 500 ms; 50-reader load | 9 | 🟨 50 simultaneous readers: server-side p95 ≈ 230 ms (client-seen p95 ≈ 394 ms), about 165 decisions/s from one API process on a laptop, 0 errors in 3,000 requests. No sustained-hour run, no multi-instance run, no k6 | k6 50-reader run |
| NFR-04 | Availability 99.5 % in term; health checks, backups | 10 | 🟨 `/health` ✅; no uptime claim | ops guide |
| NFR-05 | Scales to 100+ readers | 9 | ⬜ | load test |
| NFR-06 | Tamper-evident logs, retained ≥ 1 academic year | 2/9 | 🟨 hash chain + append-only ✅; retention job ⬜ | `audit.e2e.ts` |
| NFR-07 | Security: TLS, Argon2id, HMAC readers, replay protection, RBAC, rate-limit, CSP/CSRF/XSS, secret storage | 2–9 | 🟨 Argon2id, RBAC, rate limit, CSRF, helmet, AES-GCM secrets ✅; TLS (deploy), reader HMAC ⬜ | SECURITY_MODEL.md |
| NFR-08 | Privacy: Uganda DPPA 2019 minimisation, retention, purposes | all | 🟨 designed; DPIA/lawful basis are institutional tasks | BIOMETRIC_PRIVACY.md |
| NFR-09 | Usability: responsive 360–1440, WCAG AA, 44 px targets, reduced motion | 5/6/9 | 🟨 wallet + reader verified at 360/390/768/1024/1280/1440: no horizontal overflow, ≥44 px targets, axe WCAG A/AA clean, token contrast guard (incl. card gradient), reduced motion, visible focus. **Admin console verified the same way** (every page × 6 widths, drawer, dialogs, focus trap). **Screen-reader and manual testing outstanding** | `responsive.spec.ts`, `admin-responsive.spec.ts`, `contrast.spec.ts`; screenshots in `docs/evidence/screenshots` |
| NFR-10 | Maintainability: strict TS, tests, CI, docs, migrations | 2 | 🟨 strict TS ✅, CI file ✅ (unrun remotely), migrations ✅ | CI |

## Biometric amendment (BIO-01…BIO-10) — derived from amendment §18–28

| ID | Requirement | Status |
|---|---|---|
| BIO-01 | Card **or** face resolves to the same student & same rules engine | 🟨 ✅ FACE is a third credential in the one `/access/verify` pipeline (same rules, anti-passback, meal and exam claims); tested in `face.e2e.ts`; mock engine only |
| BIO-02 | 1:1 verification default; 1:N only behind approved feature flag, scoped gallery | 🟨 ✅ 1:1 only; 1:N not implemented (reported as disabled) |
| BIO-03 | Low confidence / ambiguous ⇒ no automatic grant; staff fallback | 🟨 ✅ below-threshold ⇒ `FACE_NO_MATCH` with card/QR fallback message; ambiguity only meaningful for 1:N (⬜); staff override flow ⬜ |
| BIO-04 | ~~Optional enrolment with privacy notice + consent~~ **Superseded by D-039 (user directive): enrolment is compulsory**, with notice, exemptions and a policy switch back to voluntary | 🟨 compulsory enrolment, pending list, exemptions, enforcement date, notice versions ✅ (`face-compulsory.e2e.ts`, browser demo 12); consent no longer the lawful basis, so the legal review is **open**; non-biometric route only for exempt students |
| BIO-05 | Maintained SDK for detection/liveness/embedding (no home-made); **mock adapter clearly labelled** | 🟨 mock adapter built and labelled everywhere (`isMock`, PROTOTYPE badge, console banner); **real SDK ⬜ (blocked on approval)** |
| BIO-06 | Encrypted templates, model version, provenance, revocation; no raw images stored by default | ✅ AES-256-GCM templates (AAD = enrolment), model version row with `is_mock`, templates overwritten on revoke, no image ever leaves the browser (only 24×24 luminance numbers) |
| BIO-07 | Student can view/withdraw/delete/re-enrol; admin suspend/migrate | 🟨 view / withdraw / delete / re-enrol ✅ (portal "My face", staff revoke); admin suspend and model migration ⬜ |
| BIO-08 | Signed short-lived identity assertion to access API; client `student_id` never trusted | 🟨 client never supplies a student id (only a claimed reg no that must then match); the biometric service runs **in-process**, so no signed assertion yet (D-038) ⬜ |
| BIO-09 | Face online-only; no template caching on browser readers; no surveillance/emotion inference | ✅ reader never falls back offline for face; templates never leave the server; no continuous scanning or inference |
| BIO-10 | Policy: card LOST ≠ account suspension; tested (FACE-06) | ✅ lost card does not stop face; suspended account does (`face.e2e.ts`) |

## Source test cases

| ID | Scenario | Phase | Status |
|---|---|---|---|
| TC-01 | Eligible student, correct exam room/window → GRANT + attendance | 3/7 | ✅ API e2e (UI demo pending) |
| TC-02 | Insufficient finance clearance → DENY (finance reason) | 3/7 | ✅ API e2e (UI demo pending) |
| TC-03 | Unregistered course unit → DENY | 3/7 | ✅ API e2e (UI demo pending) |
| TC-04 | Lost/blocked card at gate → DENY + security alert | 3/4 | ✅ API e2e for QR **and TAP** (UI demo pending) |
| TC-05 | Overdue library items → borrowing DENY | 7 | ✅ API e2e (loan → overdue → DENY → return → GRANT) + browser journey (librarian console → wallet QR → reader) |
| TC-06 | Repeated gate ENTRY without EXIT → DENY (anti-passback) | 7 | ✅ API e2e (ENTRY/ENTRY/EXIT/ENTRY, simultaneous scans, policy `gate_direction_required`); offline gate readers do not enforce it (cached list) ⚠ |
| TC-07 | Offline with valid cache → policy-compliant decision + queued log | 5 | ✅ API + engine + **real browser** (`setOffline`: local GRANT, replay refused locally, queued, reconciled on reconnect, offline rows on the server); exam readers deny offline |
| TC-08 | Finance clears student → next verify GRANT | 7/8 | 🟨 Finance API + console + audit + notification ✅ (API e2e GRANT after update; browser: console update → student eligibility changes); offline cache republish on change ⬜ (Phase 8) |
| TC-09 | Replayed request → nonce reuse rejection | 3 | ✅ API e2e (UI demo pending) |
| TC-10 | Copied UID + wrong key, or expired QR → rejection | 3/4 | ✅ API e2e: copied UID + wrong AES key rejected at mutual auth (logged + alerted); expired QR; wrong-key QR (UI demo pending) |
| FACE-01…10 | Face scenarios (amendment §27) | 6/7 | 🟨 covered: grant parity, ineligible still DENY, liveness failure, no-match/unknown, withdrawn consent, lost card with valid face, unauthorised enrolment; ⬜ duplicate meal/exam across QR+face (same DB constraints, not yet a face-specific test), face-service-offline fallback (in-process) |
| Extra | Duplicate issuance ✅ (DB), wrong venue, duplicate exam attendance ✅ (DB), duplicate meal ✅ (DB), reader revocation, stale cache, concurrency ✅ (card race), permission escalation ✅, invalid imports, recovery | | partial |

Scale targets: ≥ 50 rules-engine cases, 1 000 simulated taps, 50-reader load test with measured p95 — Phase 3/9.

## Eight end-to-end demonstrations (prompt §14/§27)

1 gate scan · 2 exam finance refusal · 3 finance update → re-scan GRANT · 4 library return clears borrowing · 5 second meal denied ·
6 lost card replaced, old credential rejected · 7 offline gate logs queued then synced · 8 replay/cloned-card rejection.
Status: backend paths for **1 (gate scan), 2 (exam finance refusal), 3 (finance fact change → re-scan GRANT; the Finance workflow itself is Phase 7), 6 (lost card replaced, old credential rejected; simulator ATK-11) and 8 (replay/cloned-card rejection; simulator ATK-01…12)** are exercised end-to-end over HTTP by the e2e suite and the live `kiu-sim` run. **7 (offline gate) now also runs in a real browser (reader + wallet UIs).** Demos 1, 2, 6 and 8 additionally have a browser path (wallet QR → reader GRANT/DENY; lost card refused; replay refused). **4 (library return clears borrowing) and 5 (second cafeteria meal denied) are ⬜**; the admin-side steps of demos 2/3 (Finance update UI) are Phase 7. Each must use the real backend and persistence; no frontend-only decisions.

## Policy values awaiting KIU confirmation (configurable, not hard-coded)

Exam fee-clearance percentage (PDF's 100 % is an example) · library fine threshold for borrowing · lost-card replacement fee · gate semester-registration requirement · offline policy per service · log retention periods · biometric lawful basis, retention and 1:N approval · meal-sitting times · card validity period.
