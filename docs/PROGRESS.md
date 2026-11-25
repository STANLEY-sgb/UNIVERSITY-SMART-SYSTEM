# Progress Log

_Last updated: 2026-11-14 (session 6) · Resume here._

## Current state
**Phases 1–5 ✅ (card/QR/offline slice) · Phase 6 🟨 (admin console built; face route built with a **prototype-only** adapter, see "Face verification") · Phase 7 🟨 core non-biometric workflows built (see "Phase 7 slice").**
Three working web apps (admin console, student wallet, reader) are driven against the real API in a real browser. No FR is fully ✅ in the [matrix](REQUIREMENTS_TRACEABILITY.md): most university service workflows, integrations, reports and the face route are still missing.

## Verified (real PostgreSQL 18 UTF-8, real crypto, real browser; nothing mocked) — one clean back-to-back run
| Suite | Tests |
|---|---|
| `@kiu/shared` | 6 |
| `@kiu/security` | 15 |
| `@kiu/rules-engine` | 96 |
| `@kiu/vcard` | 49 |
| `@kiu/offline-core` | 20 |
| `@kiu/api` (auth, rbac, audit, constraints, students, access, cards, tap, simulator, throttle, offline, eligibility, self-service, admin API, service workflows, hostel / meal / timetable management, CSV imports, exams, settings, overrides, reports, domain reports, events) | 246 |
| `@kiu/reader` (browser HMAC ≡ server, QR decode, token contrast guard) | 22 |
| `@kiu/student-portal` (browser QR verifies with the server verifier) | 6 |
| `@kiu/admin` (route ↔ permission catalogue consistency, helpers) | 14 |
| **Unit/integration total** | **544** (`pnpm test`, 18 turbo tasks, exit 0) |
| **Playwright, Chromium, real stack** (`pnpm e2e`) | **68 / 68** total: 46/46 in one clean run (includes the university spec: Finance, Library, hostel and import journeys), plus the new role-matrix spec's 22/22 in its own clean run (see below). A later attempt to confirm all 68 together in one process was killed by the host's own memory-pressure protection (OOM, not a test failure); not yet re-confirmed as a single combined run |
| `pnpm build` 11 tasks · `pnpm typecheck` 18 tasks | clean |

Screenshots (360/390/768/1024/1280/1440 px) are regenerated into `docs/evidence/screenshots/` on every `pnpm e2e`.

## Role-by-role QA pass (session 7)
Systematic audit of all 13 roles in `ROLE_DEFINITIONS` (`packages/shared/src/permissions.ts`) against what the console nav and the API actually gate, backed by a new test: `e2e/tests/role-matrix.spec.ts`. For every staff role it confirms the console nav shows exactly the sections its permissions grant (cross-checked against `apps/admin/src/lib/nav.ts`'s `ROUTE_META`/`visibleRoutes`), and that one permission it holds and one it lacks are respectively allowed and refused (403) at the API; a STUDENT case confirms self-service works and staff endpoints are refused. SUPER_ADMIN's MFA enrolment and nav are already covered by `admin.spec.ts`'s dedicated MFA test, so it is not duplicated here; ICT_ADMIN's own first-time MFA enrolment is exercised directly, including a check that the Face verification page actually loads its data (not just that the nav link is visible) — the exact thing the fix below was for.

**Two real defects found and fixed:**
* **ICT_ADMIN held `biometrics.policy.manage` but not `biometrics.view`** (`packages/shared/src/permissions.ts`), so the Face verification page it needs in order to use that policy-management permission was unreachable (the nav/route gate only checks `biometrics.view`). Fixed by adding `biometrics.view` to ICT_ADMIN's permission list.
* **Stale demo data, not a code defect:** the seeded `finance-officer@kiu-demo.test` account (used by `university.spec.ts`'s "demo 3" and relied on by `.demo-data/CREDENTIALS.md`) had been left `SUSPENDED` in the long-lived local demo database from earlier manual testing, silently breaking that documented login. Reactivated through the real `PATCH /users/:id` reactivation endpoint, not a direct database edit. The throwaway database `pnpm e2e` creates each run is unaffected.

Static review of every `can(me, …)` permission gate in `apps/admin/src/pages/*.tsx` (Readers, Exams, University [Finance/Library], Campus [Hostels/Meals/Timetable], Overrides, Rules, Students, Records, Reports) found all of them correctly scoped to the matching role permissions — no further defects.

**Not re-verified by this pass:** BIOMETRIC_OFFICER's live camera-capture enrolment flow (already covered by `face.spec.ts`, under a different login); the reader/gate "role" is device HMAC-key auth, not a staff login, and is covered by `reader.spec.ts`; anything already marked ⬜ in `docs/REQUIREMENTS_TRACEABILITY.md` is unbuilt, not a regression.

## Phase 7 slice (session 6): university service workflows
* **Gate anti-passback** (TC-06): ENTRY after ENTRY → `ANTI_PASSBACK`; EXIT always recorded; claim is one atomic insert/conditional update. A missing direction is not tracked unless the policy `gate_direction_required` is true (D-035, **default off: readers that send no direction get no anti-passback**).
* **Cafeteria**: needs a live meal sitting; one meal per student per sitting per day enforced by a DB unique key; a denied scan never consumes the meal (D-037). **Lecture**: timetable lookup by room/day/time, context `course_unit`, attendance once per day. **Hostel**: allocation vs the reader's hostel.
* **Finance / Registry / Library APIs** (reason-required, audited before/after, student notified, effect on the next scan): `PATCH /finance/students/:regNo`, `PATCH /registry/students/:regNo/registration`, loans create/return/list and fines. See API_REFERENCE.
* **Console pages**: Finance clearance, Library loans, **Hostels** (allocate / move / end), **Meal sittings** (change windows, overlap and order validated), **Lecture timetable** (add / remove, room-clash check, lectures with recorded attendance are protected). All audited with reasons; all in the six-width layout + axe run.
* An unallocated student now gets `HOSTEL_NOT_ASSIGNED` instead of `FACT_UNKNOWN` (no allocation is a known fact).
* **Verified:** 17 new API tests (anti-passback sequence, concurrent scans, policy switch, meal once/denied/no-plan/out-of-window, lecture attendance, hostel, Finance→next scan with audit + notification, permission/validation errors, library overdue→return→grant, fines); browser journeys demo 3 (Finance update in console changes the student's eligibility) and demo 4 (overdue loans block the QR scan, librarian returns them, next scan granted).
* **Not covered:** simultaneous scans of the same card are mostly stopped earlier by the QR counter, so the meal/anti-passback database claims are not separately stress-tested by competing scans from different credentials. The meal claim happens before the access log write (D-037 edge). Times use the server clock (D-036). Lecturer-level tools (marking absences, attendance reports) do not exist; attendance is only what scans record. Offline gate readers do not enforce anti-passback.
* **Defects found on the way:** an existing flaky offline-core test (flipping the final base64url signature character sometimes decodes identically) now flips a middle character; the admin-api dashboard test depended on a shared top-N list; the cafeteria test assumed the wall clock.

## Production packaging (session 6)
`docs/DEPLOYMENT.md` + `deploy/`: multi-stage Dockerfile (api, web/Caddy), `docker-compose.prod.yml` (database not published, api, Caddy on 80/443 with automatic HTTPS, daily backup job), `Caddyfile` (one hostname per app, each same-origin with the API, security headers, CSP, SSE-safe proxy), `gen-secrets.mjs`, `backup.sh`, `.env.production.example`, and `apps/api/src/seed/create-admin.ts` (first super administrator, random one-time password, no demo data). **Verified:** `pnpm verify:prod` runs the compiled API in production mode against a throw-away database, 22/22 checks (refuses placeholder secrets / insecure cookies / demo accounts, docs hidden, headers, no demo logins, forced MFA enrolment for the new administrator, Secure+HttpOnly cookies, no CORS). **Not verified:** the Docker images, compose file, Caddy config and backup container (no Docker on the development machine), a restore rehearsal, load/endurance/penetration testing. DEPLOYMENT.md lists seven go-live gates (real face SDK, lawful basis, real policy values, real data feeds, security review, operations, institutional approval); none is closed by this packaging.

## Compulsory face enrolment (session 6, user directive, D-039)
Enrolment is now compulsory for every student (policy `ENROLMENT_REQUIRED`, default on). **API:** `GET /biometrics/pending` (summary counts + paged list of who still has to enrol), `POST /biometrics/exemptions` and `/revoke` (`biometrics.policy.manage`, 10+ character reason, audited, student notified), policy now also takes `enrolmentRequired` and `enforceFrom` (date or null), `GET /me/biometrics` reports `required`, `enforceFrom`, `exempt`. **Enforcement:** from `enforceFrom`, any card/QR scan by a student who is neither enrolled nor exempt is refused with `FACE_ENROLMENT_REQUIRED` (not overridable); enrolling or being exempted lifts it at once; before the date nothing is refused. Offline readers do not enforce it. **Console:** "Who still has to enrol" card (counts, status chip, Enrol now / Exempt), policy controls (compulsory/voluntary, enforce-from date), notice text from the API. **Wallet:** banner on Home and in My face with the deadline, exemption shown. **Tests:** 6 API tests (`face-compulsory.e2e.ts`) + browser demo 12; migration 0005 adds `biometric_exemptions`. **Default:** compulsory, with **no** enforcement date, so nothing is blocked until someone sets one in Face verification → Policy. Legal basis is NOT established (see D-039).

## Artwork background and palette (session 6, user feedback)
The solid yellow page background was replaced by the supplied artwork, redrawn as vector SVG (portrait and landscape variants), with all colours sampled from the image. Content sits on frosted panels; sidebar plum, primary buttons teal, active nav sun-yellow, student ID card violet-to-plum. Contrast tests (reader `contrast.spec.ts`, now 40 cases) check text against the panel over every artwork colour. Reviewed in real screenshots of the admin console, wallet and reader at desktop and phone width. The layout/axe browser test (`admin-responsive`, `responsive`) was **not re-run** after this change because the user's demo was occupying the browser-test ports; run `pnpm e2e` with the demo stopped.

## Excel (.xlsx) import (session 6)
The Data imports page now accepts `.xlsx`: the **browser** reads the first sheet (shared/inline strings, numbers, booleans, formula cached values) with `fflate` and turns it into CSV, so the server's parser, limits (200 KB, 1000 rows), preview, checksum and idempotency are unchanged and the server never opens a spreadsheet container. A zip-bomb guard refuses anything that would inflate beyond 8 MB, only the needed XML parts are inflated, and non-workbooks get a clear message. 5 unit tests (`xlsx.spec.ts`). Limits: values only (no macros, styles or other sheets), dates remain Excel serial numbers (no import dataset uses dates), `.xls` is not supported. No browser journey uploads an `.xlsx` yet.

## Office reports (session 6)
`GET /reports/catalog` lists the reports the caller's own permissions allow; `GET /reports/domain/:kind` (`?from&to` for ranged ones, `?format=csv`) runs one: **exam-attendance** (`exams.attendance.view`), **finance-clearance** (`finance.view`, students not cleared), **library-overdue** (`library.view`), **meals-served** (`cafeteria.view`), **hostel-occupancy** (`hostel.view`). The data permission is the report permission; CSV additionally needs `reports.export`, is formula-safe, capped at 5,000 rows and audited (`reports.exported`). Console: "Office reports" card on the Reports page. 5 API tests. Browser demo 5 is extended for it and passes (45/45 clean run). Not done: PDF, charts per report, scheduled reports.

## Performance measurement (session 6)
`pnpm bench` boots a throw-away stack, signs real requests and reports latency percentiles and throughput into `docs/PERFORMANCE.md`. A first version of the benchmark accidentally measured only anti-passback denials; it now alternates ENTRY/EXIT so ~97% of requests are real GRANTs. The throughput ceiling (~165/s) is a single-process laptop figure.

## Local demo launcher (session 6)
`pnpm demo` / `start-demo.bat` starts a persistent PostgreSQL (`.demo-data`), migrates, seeds, creates a full-permission no-MFA `demo-admin@kiu-demo.test`, provisions demo readers (one face-capable gate) and four student cards through the real API, and serves the API and three apps (:4000, :3000-3002). Walkthrough: `docs/DEMO_GUIDE.md`; generated credentials: `.demo-data/CREDENTIALS.md`. Verified by starting it from scratch and restarting it with saved data; killing it without Ctrl+C can leave a PostgreSQL worker holding port 54330.

## Live events and exam seating (session 6)
* **Live dashboard:** `GET /events` is a server-sent-events stream (`reports.view`, same cookie/bearer auth, max 200 streams, 25 s heartbeat). Events carry no personal data: `decision` (GRANT/DENY, service) from every `/access/verify` result and `alert` (kind, severity) from raised alerts; the console re-queries what the viewer is allowed to see (throttled to ~2 refreshes/s) and keeps a 30 s poll as a safety net. Alerts written directly by overrides and the face lockout do not push (they appear on the next refresh). Offline-synced decisions are not pushed either. 3 API tests over real HTTP + browser demo 11 (a decision appears within 8 s although polling is 30 s).
* **Exam seating:** `GET /exams/sessions/:id/seats`, `POST .../seats/auto-assign` (enrolled, active, unseated students in registration order, first free labels A1–A20, B1…; refuses when the hall's capacity would be exceeded; serialised by an advisory lock), `POST .../seats` (manual set or move; seat-taken and not-enrolled refused). Admission tells the student their seat ("Your seat is C7."). Console **Seats** dialog on the Examinations page. 2 API tests. Not done: seat plans/maps, enforcing that a student may only enter at their own seat, printing.
* **Test hygiene:** one existing cafeteria test depended on the hour it ran (it passed only outside lunch); it now moves every sitting out of the way and restores them.

## Settings, overrides, registration, face hardening (session 6)
* **Settings** (`settings.manage`): `GET|PATCH /settings/policy` (fine limit, minimum fees %, gate direction required; reason + before/after audit; applies to the next scan), venues (`GET|POST /settings/venues`, `PATCH /settings/venues/:code`, hours/capacity validated), academic calendar (`GET|POST /settings/sessions`, `POST /settings/sessions/:id/semesters` with overlap/inside-session checks, `POST /settings/semesters/:id/make-current` atomically switches the one current semester). Console **Settings** page. 4 API tests + browser demo 8.
* **Manual overrides** (`access.override`): `POST /access/overrides` needs a genuine DENY for that student and service in the last 30 minutes and a reason of 10+ characters. Identity/credential/account/face refusals (`CARD_*`, `CREDENTIAL_*`, `NONCE_*`, `COUNTER_*`, `READER_*`, `FACE_*`, `STUDENT_SUSPENDED`) can never be overridden. Writes an `access_overrides` row, a GRANT log with `auth_method MANUAL_OVERRIDE`, an `OVERRIDDEN` exam attendance when applicable, a MEDIUM `MANUAL_OVERRIDE` alert and an audit entry; the facts are untouched, so the next ordinary scan is still refused. `GET /access/overrides` (`access.logs.view`). Console **Overrides** page. 3 API tests + browser demo 9 (the successful override path is covered by the API tests only).
* **Student registration**: console "Register student" form (programme list from `GET /programmes`), duplicates refused, starts with nothing cleared. Browser demo 10.
* **Face hardening**: after 5 failed face checks (no match / liveness) in 10 minutes a student's face is paused (`FACE_LOCKED`, MEDIUM `FACE_LOCKOUT` alert); card/QR and other students are unaffected; a success clears the count. Face meal-per-sitting parity test added.

## Face verification (session 6, prototype adapter, D-038)
* **Engine:** `MockFaceAdapter` only, labelled everywhere. No accuracy, anti-spoofing or demographic evidence exists; do not use it to protect anything real. Real use needs an approved SDK, evaluation and privacy review (docs/BIOMETRIC_PRIVACY.md).
* **API:** `POST /biometrics/enrollments` (officer; current notice version + explicit consent + 3–8 frames), `GET /biometrics/enrollments`, `POST /biometrics/enrollments/:id/revoke`, `GET /biometrics/notice`, `GET|PUT /biometrics/policy` (threshold 0.50–0.99, global on/off), `GET /biometrics/devices`, `PUT /biometrics/devices/:readerId` (per-reader authorisation), student `GET /me/biometrics` and `POST /me/biometrics/withdraw`. Verification is a third credential in `POST /access/verify`: `{credential: {type: "FACE", regNo, frames}}` → same rules, anti-passback and logs; logged with `auth_method FACE`.
* **Privacy design:** templates AES-256-GCM encrypted, never returned by any API, overwritten on revoke/withdraw; the browser sends only 24×24 luminance numbers; unknown and unenrolled registration numbers are indistinguishable (`FACE_NOT_ENROLLED`); failed attempts never record which student was claimed; card LOST does not stop face, SUSPENDED does; face never bypasses rules; online-only.
* **Speed (measured):** the reader journey (capture five frames, signed request, decision, animated result) completes in well under 3 s in the browser test, which asserts that bound; the server decision time is shown on screen. The face path itself has not been benchmarked (see docs/PERFORMANCE.md for the QR path).
* **UI:** shared vector `FaceCapture` (SVG oval guide, corner brackets, scanning ring, animated tick/cross, PROTOTYPE badge, camera-denied fallback) used by the console **Face verification** page (notice, consent checkbox, enrol, enrolments, revoke, policy, reader authorisation), the reader **SCAN FACE** tab and the student portal **My face** card.
* **Tests:** 8 API tests (`face.e2e.ts`), adapter behaviour, browser demo 7 with a synthetic camera stream (enrol → grant → different face denied → student deletes → reader refuses → unauthorised reader refuses).
* **Not done:** a real SDK, 1:N, signed assertions / separate service (BIO-08), admin suspend/migrate, staff override on low confidence (overrides never cover face refusals), a face-specific duplicate-exam test, a manual test with a real phone camera and real faces, any accuracy/FMR/FNMR/demographic evaluation.

## Examination scheduling (session 6)
* `GET /exams/sessions?when=upcoming|past|all` and `GET /exams/halls` (`exams.view`); `POST /exams/sessions` and `POST /exams/sessions/:id/cancel` (`exams.manage`, reason required, audited); `GET /exams/sessions/:id/attendance` (`exams.attendance.view`).
* Validation: end after start, max 12 h, venue must be an EXAM_HALL, a current semester must exist (`NO_CURRENT_SEMESTER`), one exam per course per semester (`ALREADY_SCHEDULED`), no overlapping use of a hall (`VENUE_CLASH`), cannot cancel once attendance exists (`HAS_ATTENDANCE`). Entry window defaults to 60 min before / 30 min after the start; the console does not yet expose custom windows.
* Console: **Examinations** page (schedule form, upcoming/past/all, cancel, attendance list). 5 API tests + 1 browser journey. Not done: seat allocation UI, venues and academic-session management pages, editing a scheduled exam (cancel and re-create).

## Reports and CSV export (session 6)
* `GET /reports/access?from&to` (`reports.view`): zero-filled per-day grants/denies, by service, busiest readers, top denial reasons, by auth method. Aggregates only, no personal data. Dates are server-local YYYY-MM-DD, default last 7 days, max 93 days (`DATE_INVALID`, `RANGE_INVALID`, `RANGE_TOO_LARGE`).
* `GET /reports/access/export` (`reports.export` AND `access.logs.view`, because it lists registration numbers): UTF-8 CSV with BOM, capped at 10,000 rows (a trailing comment row says when truncated), spreadsheet-formula cells neutralised, `Cache-Control: no-store`, every export audited (`reports.access_exported`).
* Console: **Reports** page (date range, totals, per-day chart, tables, Download CSV only when permitted). 9 API tests + 1 browser journey.
* Not done: PDF export, other report types (attendance, finance, hostel), scheduled reports.

## CSV imports (session 6, FR-08 partly)
* `POST /imports/preview` validates the whole file against the database and changes nothing; `POST /imports/commit` re-validates the file itself (the preview is never trusted), applies the valid rows in **one transaction**, writes one audit entry per changed row plus one for the job, notifies students whose clearance changed, and records a `sync_jobs` row. Datasets: **Finance** (fees %, exam cleared), **Registry** (semester registered), **Library** (fines). Each needs the same permission as the single-student edit.
* Safety: commit must present the previewed file's sha256 (`FILE_CHANGED` otherwise); the same file cannot be imported twice (`DUPLICATE_IMPORT`); unknown/missing columns, duplicate or unknown students, out-of-range values and unterminated quotes are rejected with specific messages; limits 1000 rows / 200 KB (below the 256 KB body limit). Rows with errors are skipped and reported; valid rows still apply (job status `COMPLETED_WITH_ERRORS`).
* Console: **Data imports** page (file or pasted CSV → preview with before/after → reason → apply; recent jobs). 13 API tests + 6 parser tests; browser journey for Finance.
* **Not done for FR-08:** a mock Finance/Registry/Library HTTP API, scheduled/webhook sync, hostel import, and republishing offline lists on change (readers pick up changes on their next list sync; see the stale-grant bound). The Librarian role has no `integrations.view`, so it cannot open the Data imports page (the API would still allow its library import).

## What Phase 6 (console half) added
* **API:** `GET /dashboard/summary` (live aggregates; recent decisions/admin actions only for callers who may see them), `GET /alerts` + `POST /alerts/:id/ack`, `GET /services`, `GET /venues`, `GET /students/:id/overview` (facts / cards / access history each gated by permission).
* **`apps/admin`** (Vite + React, D-031): sign-in with TOTP challenge and **forced MFA enrolment** (secret, code check, one-time recovery codes); permission-aware navigation; **Overview** (live stats, hourly chart, denial reasons, by-service, recent decisions/actions, alert banner, 10 s refresh); **Students** (search/filter/paginate, detail dialog, issue card); **Cards** (issue, block, unblock, report lost, replace, re-enrol, each with an audited reason; activation codes shown once); **Readers** (provision with secret shown once, rotate, disable, revoke, online/offline); **Rules** (JSON editor, precise validation errors, test against a real student with trace, save draft, publish, history, rollback); **Access logs**; **Alerts** (acknowledge); **Audit** (filters + hash-chain verification); **Staff & roles** (add, suspend, role catalogue).
* **`@kiu/ui`:** `DataTable` (cards on phones), `Pager`, accessible `Modal` (focus trap, Escape, focus return), `BarChart` (SVG with text summary), admin shell styles.
* **Browser journey tested end to end:** issue in the console → activate in the wallet (another browser context) → reader GRANT → block → unblock → lost → reader DENY + alert → acknowledge → audit entries + chain verified. Also: reader credentials shown by the console really authenticate; rotation/revocation take effect immediately; a suspended user's live session dies at once.

## Defects found by this phase's checks (all fixed)
1. `.link-btn` (names in tables) was 24 px tall, below the 44 px target contract.
2. Stacked table cells with several children (name + email) laid out side by side and pushed the phone page to 415 px.
3. Below 1024 px the shell grid column sized to its widest content (table), so the table's own scroll never engaged → `minmax(0,1fr)`.
4. Wide tables at 768/1024 hid action buttons off-screen → table cells now wrap anywhere.
5. Empty traffic chart rendered a blank box + legend → shows a message instead.
6. `pnpm test` failed because the admin app had a test script and no tests → real unit tests added (not `--passWithNoTests`).
7. Test-script races/timing: editor read before content loaded; layout/axe sampled mid-animation (43 px targets, mid-fade contrast) → `settle()` helper; student on page 2 of a sorted list.

## Known gaps / honest limitations
* **Biometrics/face route: not started** (Phase 6b). `SCAN FACE` and `VIRTUAL TAP` stay disabled with an explanation; browser AES tap needs a vetted library (D-029).
* Console modules **not built**: venues, academic sessions, examinations, overrides, integrations/imports, reports/exports, system settings, create-student form. Backend workflows for those (anti-passback, one-meal, lecture, library/hostel, imports, WebSocket/MQTT, reports) are also absent.
* MFA secret is entered manually (no QR rendering). No per-action step-up re-authentication. No CSP configured by the console itself.
* Camera scanning still has no automated browser test (headless); manual phone test outstanding. Screen-reader testing outstanding; automated checks are axe WCAG A/AA + a token contrast test.
* Performance: `pnpm bench` measures the online QR decision against the real stack (docs/PERFORMANCE.md): one reader p95 ≈ 27 ms; 50 simultaneous readers p95 ≈ 394 ms, ≈165 decisions/s, no errors, on one laptop. No sustained, multi-instance, real-network or face measurement; availability (NFR-05) unproven.
* Wallet/reader keys are software-backed; an isolated reader cannot learn later revocations (30-min list + stale-grant alert bound it).
* GitHub Actions (with `test` and `e2e` jobs) unrun remotely. Not a git repository.

## Open items / blockers
1. **Provide the 41-page KIU guide and the UI screenshot** (D-001).
2. Confirm policy values (card validity, fine limit, offline list life, gate registration rule).
3. Manual camera test on a real phone; screen-reader pass.
4. ~~Biometrics decision~~ decided by the user on 2026-11-15: build now with the labelled mock adapter (D-038). An approved SDK and privacy review are still required before any real use.

## Environment notes
Node 26 / pnpm 10.34 (via npm; **never `corepack enable`**). Chromium for Playwright is installed. **`pnpm e2e` does not build the API:** run `pnpm --filter @kiu/api build` first if API/seed source changed (the stack runs `apps/api/dist`); it builds the three web apps itself and starts its own database (~7 min for all 34). No Docker: DB tests use embedded PostgreSQL (UTF-8). Python absent. Shell rules: no backticks/template literals inside `node -e "..."`, no apostrophes in bash heredocs — write a script file with the Write tool and run it. Local `.env` points at the embedded dev DB on port 54329.

## Next session
The full 38-test browser run is clean. Without any user decision needed: more report types and PDF, seat maps, a sustained/multi-instance load test. Biometrics (Phase 6b) only after the decision in "Open items" #4 (still unanswered).

### Phase 6b detail (biometrics)
Follow `docs/BIOMETRIC_PRIVACY.md`: consent + enrolment API (officer-verified, notice version, lawful basis), encrypted template store behind a separate service boundary with a **mock adapter clearly labelled prototype-only** (and `is_mock` surfaced everywhere), signed short-lived identity assertions bound to reader+nonce accepted by `/access/verify` as a third credential type, 1:1 by default (1:N flag off), liveness/ambiguity/no-enrolment/consent-withdrawn denials, student "my face" settings (view/withdraw/delete), console enrolment screens for the Biometric Officer role, reader `SCAN FACE` tab with privacy notice and non-biometric fallback, tests FACE-01…10 and BIO-01…10. Then Phase 7 workflows (anti-passback, one-meal, library/hostel/lecture, Finance/Registry imports) and Phase 8 live events/reports.
