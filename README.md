# KIU Unified Smart Card Access System (KIU-USCAS)

Software-first prototype of a university-wide identity and access platform: one student identity, one virtual smart card
(rotating Ed25519 QR **or** AES mutual-authentication tap) and, later, an opt-in face credential, with many independently
configurable service entitlements decided by one central, versioned rules engine.
**All data is fictional. Not approved by, or integrated with, Kampala International University.**

> **Status: Phases 1–5 complete for the card/QR/offline slice, plus an admin console and the first university workflows (gate anti-passback, cafeteria, lecture, hostel, Finance, Registry, Library) — see [docs/PROGRESS.md](docs/PROGRESS.md).**
> Working: API, **admin console**, student wallet, reader app (online + offline), CLI simulator, CSV imports, reports, exam scheduling and seating, settings, manual overrides, live dashboard events, and a **compulsory-by-policy face route (with exemptions) that runs on a prototype-only mock engine** (no accuracy or spoof-resistance evidence). **Not built yet:** a real face SDK, a browser AES tap, lab/health/sports/transport workflows, Excel import, PDF/other reports, load testing. Do not read this repository as a finished system.

> **Deploying:** see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (production packaging and the go-live gates; nothing has been deployed). `pnpm verify:prod` checks the API in production mode.
>
> **Try it yourself:** double-click `start-demo.bat` (or run `pnpm demo`), then follow [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md). Logins and reader credentials are written to `.demo-data/CREDENTIALS.md`.

## What works today
* **Admin console** (`apps/admin`): sign-in with MFA (forced enrolment for privileged roles); live overview; students; cards (issue / block / lost / replace, each with an audited reason); readers (provision, rotate, revoke); rules editor (validate, test against a real student, publish, roll back); **Finance clearance, Library loans, Hostels, Meal sittings, Lecture timetable and CSV data imports (preview, then commit) and access reports with audited CSV export** (audited, effective on the next scan); access logs; alerts (acknowledge); audit trail with integrity check; staff and roles. Navigation follows permissions; the API enforces them.
* **Student wallet** (`apps/student-portal`, PWA): sign in, activate a card with an on-device key, rotating 30 s QR, “My access” with reasons and the office to contact, history, notifications, report lost.
* **Reader** (`apps/reader`, PWA): onboard with provisioned credentials, scan by camera or code, big GRANT/DENY with reason, sound and a 3 s door animation, online-first (800 ms) then **offline from a signed list**, queued logs synced idempotently.
* **API**: auth (Argon2id, MFA, RBAC, audit hash-chain), card issue → activate → block / lost / replace, `POST /access/verify` for QR and AES tap through one pipeline, versioned JSON rules (draft → test → publish → rollback), reader provisioning, signed offline allow-list, eligibility, self-service.
* **`kiu-sim`** CLI: legitimate QR + tap and 12 attack scenarios against a live server.

## Documentation
[Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE_DESIGN.md) · [API](docs/API_REFERENCE.md) · [Design system](docs/DESIGN_SYSTEM.md) ·
[Security](docs/SECURITY_MODEL.md) · [Biometric privacy](docs/BIOMETRIC_PRIVACY.md) · [Traceability](docs/REQUIREMENTS_TRACEABILITY.md) ·
[Plan](docs/IMPLEMENTATION_PLAN.md) · [Decisions](docs/DECISIONS.md) · [Progress](docs/PROGRESS.md) · diagrams in [docs/diagrams](docs/diagrams) · screenshots in [docs/evidence](docs/evidence/screenshots)

## Prerequisites
Node ≥ 20.18, pnpm 10 (`npm i -g pnpm@10`; avoid `corepack enable` on Windows). PostgreSQL via **either** Docker **or** the bundled embedded Postgres (no install). A recent Chromium-based browser (WebCrypto Ed25519 is required by the wallet and reader).

## Quick start (verified on Windows 11 / Node 26 without Docker)

```bash
pnpm install
cp .env.example .env

# --- database: pick one ---
docker compose up -d postgres redis      # A) Docker (keep DATABASE_URL/DIRECT_URL from .env.example)
pnpm db:dev                              # B) no Docker; leave running; set DATABASE_URL and DIRECT_URL in .env to the URL it prints
                                         #    (default: postgresql://kiu:kiu_dev_password@127.0.0.1:54329/kiu_uscas?schema=public)

pnpm db:generate && pnpm db:deploy       # Prisma client + migrations
pnpm build
# add SEED_DEMO_ACCOUNTS=true to .env, then:
pnpm db:seed                             # roles + FICTIONAL demo data (refuses to run in production)
cd apps/api && node dist/main.js         # API on http://localhost:4000  (docs: /api/docs)
```

Then, in more terminals (the dev servers run the same code as the production builds that the browser tests exercise; the dev-server commands themselves were not separately run):

```bash
pnpm --filter @kiu/admin dev             # admin   http://localhost:3000
pnpm --filter @kiu/student-portal dev    # wallet  http://localhost:3001
pnpm --filter @kiu/reader dev            # reader  http://localhost:3002
```
Use `localhost` (not `127.0.0.1`) so the API's cookies are same-site. `CORS_ORIGINS` in `.env` already allows both ports.

**Try it:** sign in to the wallet as `student01@kiu-demo.test` (password below). A card officer (`card-officer@kiu-demo.test`) issues a card through the API (`POST /cards`) and gives you the one-time activation code. Provision a reader (`POST /readers` as a super admin with MFA, or via the simulator) and paste its credentials into the reader app. Staff sign in to the admin console at :3000 (`card-officer@kiu-demo.test`, `registry-officer@kiu-demo.test`, `management@kiu-demo.test`, …; `super-admin@` and `ict-admin@` are walked through MFA enrolment on first sign-in).

Demo logins (development only): `<role>@kiu-demo.test` (e.g. `card-officer@`, `security-officer@`, `registry-officer@`) and
`student01@` … `student12@kiu-demo.test`, password `Demo-Password-2026!`.
`super-admin@` and `ict-admin@` must enrol TOTP MFA first (`POST /auth/mfa/setup` → `/auth/mfa/enable`).

## Simulator CLI (needs a running, seeded API and an MFA-enrolled super admin)

```bash
pnpm --filter @kiu/simulator build
node apps/simulator/dist/cli.js demo      --mfa-code <6-digit TOTP>   # QR + tap with a sanitised protocol console
node apps/simulator/dist/cli.js scenarios --mfa-code <6-digit TOTP>   # 2 baselines + 12 attacks, expect 14/14
```
Credential endpoints are rate-limited (10/min/IP); wait a minute between runs.

## Tests

```bash
pnpm test        # every package + API unit/e2e on a REAL PostgreSQL (497 tests)
pnpm exec playwright install chromium    # once
pnpm --filter @kiu/api build   # first, whenever API or seed source changed (the e2e stack runs apps/api/dist)
pnpm e2e         # real browser + real API + production builds of all three apps (45 tests, ~7 min)
```
`apps/api` tests use `TEST_DATABASE_URL` if set; otherwise `infrastructure/scripts/with-db.mjs` boots a throw-away embedded PostgreSQL (UTF-8). `pnpm e2e` starts its own database, API and both apps (`e2e/stack.mjs`); the responsive spec writes screenshots to `docs/evidence/screenshots/`.
The camera path is not covered by an automated test (headless Chromium has nothing to scan); its decoding is unit-tested and every flow works through the code field.

## Layout
`apps/api` NestJS · `apps/admin` · `apps/student-portal` · `apps/reader` · `apps/simulator` CLI · `packages/{shared,security,rules-engine,vcard,offline-core,ui}` · `prisma/` schema + 4 migrations · `e2e/` Playwright · `infrastructure/` · `docs/`.

## Security notes
Secrets live only in environment variables (`.env` is git-ignored). Production refuses `COOKIE_SECURE=false`, placeholder JWT/master/signing keys and demo seeding.
Browser/phone credentials are **software-backed simulations**, not tamper-resistant secure elements. An isolated reader cannot know about revocations issued after its last sync. See [SECURITY_MODEL](docs/SECURITY_MODEL.md) for controls and residual risks.
