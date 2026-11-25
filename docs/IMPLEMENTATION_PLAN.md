# Implementation Plan

Order follows the master prompts: backend foundations → decision core → cards → readers → admin → services → integrations → quality → delivery, with a **Biometric Design + Privacy Gate** inserted after the architecture (before face matching). Each phase ends with a verification gate; do not start the next until it passes. Live status: [PROGRESS.md](PROGRESS.md).

| # | Phase | Deliverables | Verification gate | Status |
|---|---|---|---|---|
| 1 | Analyse | Matrix, ERD, API inventory, security model, decisions, UI map, storyboard | Docs reviewed; gaps logged (D-001) | ✅ |
| 2 | Foundation | Monorepo, Docker Compose, PostgreSQL, NestJS, Prisma schema + migrations, auth/RBAC/MFA, audit, seeds, CI | API e2e on real PostgreSQL green; typecheck/build clean | ✅ (see PROGRESS) |
| 2b | Biometric gate | Privacy design, policies, schema, mock-adapter plan | BIOMETRIC_PRIVACY.md reviewed | ✅ design |
| 3 | Core decision | `packages/rules-engine` (≥50 cases), rule versioning/validation API, reader provisioning + HMAC auth, nonce store, credential verification interface, `/access/verify`, access log, alerts | TC-02/03/04/09 + 50 rule cases + concurrency green | ✅ (QR route; see PROGRESS) |
| 4 | Card ecosystem | `packages/vcard` (CMAC diversification, 3-pass auth, Ed25519 QR, test vectors), issuance/lifecycle, revocation list, simulator app + attack scenarios | TC-04/10; lost-card flow; one-active-card API | ✅ API + CLI simulator (web simulator UI and revocation-list endpoint move to Phase 5) |
| 5 | Reader + offline | Reader PWA (QR camera, tap, result UI, segmented SCAN QR/TAP/FACE), student wallet, signed cache, IndexedDB queue, reconciliation | TC-07; offline tests incl. stale cache | ✅ QR wallet + reader + offline (21 browser tests). **Browser virtual tap deferred (D-029)**; face is Phase 6 |
| 6 | Administration (+biometrics) | Next.js admin with premium design system; students/cards/rules/readers/roles/audit; biometric enrolment, consent, adapter, assertions, face reader | FACE-01…10 | 🟨 **admin console ✅ (9 of 22 modules, verified in a browser); biometric enrolment + face route ⬜ (not started)** |
| 7 | University services | Gate+anti-passback, library, exam, lecture, hostel, cafeteria, lab, health, sports/events/transport, graduation + operator UIs | TC-01/05/06/08; demos 1–6 | ⬜ |
| 8 | Integrations | CSV/Excel import (preview/validate/commit), mock adapters, BullMQ jobs, cache invalidation/publish, WebSocket, MQTT, notifications, reports (CSV/PDF) | invalid-import & idempotency tests; live events | ⬜ |
| 9 | Quality | Playwright E2E (8 demos), security tests, axe + responsive visual regression (360–1440), k6 (1 000 taps, 50 readers, p95) | Measured results recorded honestly | ⬜ |
| 10 | Delivery | README, ops/backup/deploy guides, Docker from clean checkout, final matrix, limitations report | Acceptance gate (prompt §17) | ⬜ |

## Phase 3 task breakdown (DONE — reference only; **next session starts at Phase 5**, see PROGRESS.md)
1. `packages/rules-engine`: JSON schema (zod) for `all/any/not`, ops `eq neq gt gte lt lte contains between in`, `{ctx: ...}` / `{fact: ...}` references, per-leaf `denyMessage` + `reasonCode`, pure evaluator returning first unmet leaf, unknown fact ⇒ fail-closed. Jest ≥ 50 cases.
2. Rules API: `GET/PUT /services/:code/rule` (draft), `POST /rules/test` (preview vs sample students), `POST /rules/:id/publish`, history, rollback; audited; seed default drafts + published rules for all 12 services (thresholds as configurable values, flagged *awaiting KIU confirmation*).
3. Readers: CRUD, credential provisioning (secret shown once, stored AES-GCM), `ReaderAuthGuard` (key id, ts skew, nonce in `credential_nonces`, HMAC over method|path|ts|nonce|body-hash), heartbeat.
4. Access pipeline `AccessService.verify()` following the sequence diagram; credential verifier interface (QR/TAP/FACE_ASSERTION) with a test double until P4; fact loader; `AccessLog` write; security alerts; `presence_state`; per-service transactional side-effects hooks.
5. Tests: TC-02, TC-03, TC-04 (card status), TC-09, wrong venue, revoked reader, concurrency, unknown fact fail-closed, rule version in log.

## Risks
| Risk | Mitigation |
|---|---|
| Source PDF missing → FR/NFR drift | D-001; re-map on receipt |
| Browser cannot hold hardware-backed keys | documented limitation; revocable device enrolment |
| Face SDK unavailable/untrusted | mock adapter, flagged prototype-only; live face disabled |
| Scope very large | strict phase gates; docs updated each increment |
| No Docker on dev machine | embedded PostgreSQL helpers (D-003) |
