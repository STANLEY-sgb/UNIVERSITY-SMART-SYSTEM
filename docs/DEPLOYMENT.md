# Deploying KIU-USCAS (production-ready packaging, not a go-live)

This document covers self-hosting on your own server with Docker. Deploying to **Vercel +
Supabase** instead is covered separately in `docs/DEPLOY_VERCEL_SUPABASE.md` — read the
"Go-live gates" section below first either way; it applies regardless of where this runs.

This document packages the system so it **can** be run on a real server. It does **not** make it safe or lawful to run with real students: read "Go-live gates" first. Nothing in this repository has been deployed anywhere.

## 1. What was verified, and what was not

| Area | Status |
|---|---|
| The compiled API in production mode (`node deploy/verify-prod.mjs`) | **Verified, 22/22 checks** on a throw-away database: refuses placeholder secrets, insecure cookies and demo accounts; applies migrations; seeds roles only; creates the first administrator with a random one-time password; hides the API docs; sets security headers; no demo logins; the new administrator is forced to enrol an authenticator app before anything else; cookies are `Secure` + `HttpOnly`; no cross-origin access. |
| Docker images, `docker-compose.prod.yml`, Caddy (HTTPS, headers, `/api` proxy), backup container | **Written but never run.** The development machine has no Docker. Build and smoke-test on the target host (section 5) and expect to fix small things. |
| Real database backups and restores | The script is written; **a restore has not been rehearsed**. Do that before trusting it. |
| Load, endurance, failover, penetration testing | **Not done.** Only a laptop benchmark exists (`pnpm bench`, `docs/PERFORMANCE.md`). |

## 2. Go-live gates (do not put real students on this until each is closed)

1. **Face recognition engine.** The only engine is a labelled prototype that compares tiny brightness thumbnails. It has no accuracy, anti-spoofing or demographic evidence. A real, independently evaluated SDK must replace it (`FaceAdapter` interface), and with compulsory enrolment (D-039) a weak engine would reject genuine students and admit impostors. Until then keep face verification switched off (Face verification → Policy) or never set an enforcement date.
2. **Lawful basis for compulsory biometrics.** Compulsory enrolment means consent is not the lawful basis. The Uganda Data Protection and Privacy Act, 2019 needs a lawful basis, a data-protection impact assessment, retention rules and probably the regulator. See `docs/BIOMETRIC_PRIVACY.md` and D-039.
3. **Real policy values.** Fee thresholds, library fine limits, meal times, card validity, offline policy are placeholders until KIU confirms them (Settings page).
4. **Real data feeds.** Students, Finance, Registry and Library data arrive today only by manual entry or CSV/Excel import. There is no live integration with KIU systems.
5. **Security review.** At least: penetration test, review of reader-secret handling, and an operations plan for key rotation. Secrets here sit in an environment file; a KMS/HSM is recommended for `CARD_MASTER_KEY` and `DATA_ENCRYPTION_KEY`.
6. **Operations.** Monitoring and alerting, log retention, an on-call owner, tested restores, a disaster-recovery target, and a human appeal process for people refused by the system.
7. **Institutional approval.** The prompt and this prototype state it is **not** approved by or integrated with KIU. Approval is KIU's to give.

## 3. Architecture

```
 browsers ──HTTPS──► Caddy (ports 80/443, automatic certificates)
   admin.example.org   ─┐   each hostname serves its own static app
   wallet.example.org  ─┼─► and forwards /api/* to ──► API (Node, port 4000, internal only) ──► PostgreSQL (internal only)
   reader.example.org  ─┘                                                            └──► backup job (daily dump)
```

Every app is **same-origin** with the API: no CORS, no cross-site cookies, and a script injected into one app cannot read another app's cookies. Only Caddy publishes ports. The database is not reachable from outside the compose network.

## 4. What you need

* A Linux server (2 vCPU / 4 GB RAM is plenty for a pilot) with Docker and the Compose plugin, ports 80 and 443 open.
* Three DNS names pointing at it (for example `admin.`, `wallet.`, `reader.` under your university's domain), set **before** the first start so certificates can be issued.
* Somewhere **off the server** to copy backups and the `.env.production` file to.

## 5. First deployment

```bash
git clone <your copy of this repository> && cd kiu-uscas
node deploy/gen-secrets.mjs admin.example.org wallet.example.org reader.example.org   # writes .env.production (mode 600)
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production logs -f api      # wait for "listening on :4000"
```

Create the first administrator (prints a one-time password; there are no default accounts):

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production exec api \
  node apps/api/dist/seed/create-admin.js you@university.example "Your Name"
```

Sign in at `https://admin.example.org`. You will be made to set up an authenticator app; nothing else works until you do. Then, in the console:

1. **Users**: create staff accounts per role (card office, registry, finance, library, security, invigilators, biometric officers). Super and ICT administrators must use an authenticator app.
2. **Settings**: replace every placeholder policy value; check venues and the academic calendar.
3. **Readers**: register each reader; copy its ID, Key ID and secret (shown once). On the device open `https://reader.example.org`, enter `https://reader.example.org` as the server address and the three values.
4. **Rules**: review each service's published rule.
5. **Face verification** (only once gate 1 and 2 are closed): authorise face-capable readers; set the enforcement date last.

Smoke test before announcing anything: issue a card to a test student, activate it in the wallet, scan it at a reader, check Access logs and the Audit trail, run **Reports**, download a CSV, and confirm a backup file appears in `backups/` after the first start.

## 6. Operating it

| Task | How |
|---|---|
| Logs | `docker compose ... logs -f api` (the API logs requests with an id; audit events are in the database, Audit trail page). |
| Update | `git pull`, then `docker compose ... up -d --build`. The API container applies new migrations on start. Back up first. |
| Stop / start | `docker compose ... down` / `up -d` (data lives in the `pgdata` volume). |
| Backups | `backup` writes `backups/kiu_uscas-<time>.sql.gz` daily and keeps `BACKUP_KEEP_DAYS` days. **Copy them off the machine** (rsync/object storage) on a schedule. |
| Restore | `docker compose ... down`; `docker volume rm kiu-uscas_pgdata`; `docker compose ... up -d db`; `gunzip -c backups/<file>.sql.gz \| docker compose ... exec -T db psql -U kiu -d kiu_uscas`; `docker compose ... up -d`. **Rehearse this on a spare machine before you need it.** |
| Reader secret lost/leaked | Console → Readers → rotate credential (the old key stops working at once). |
| Lost card | Student wallet "Report lost", or the card office. |
| Rotate `JWT_ACCESS_SECRET` | Change it and restart: everyone is signed out. Safe. |
| Rotate `DATA_ENCRYPTION_KEY` / `CARD_MASTER_KEY` / `CACHE_SIGNING_KEY` | **Not a one-line change.** The first protects stored MFA/reader secrets and face templates, the second every AES card, the third the key readers pin for offline lists. Plan a migration; do not just edit the file. |

## 7. Hardening checklist for the host

* Only ports 80/443 (and SSH from your admin addresses) reachable; automatic security updates on.
* `.env.production` readable by root only; stored in a vault; never in git.
* Backups encrypted at rest off-site (they contain personal data and encrypted face templates).
* Time sync (NTP) on the server and the reader devices: reader request signatures and QR codes are time-bound.
* Self-host the two Google Fonts so the apps make no third-party requests, then tighten the CSP in `deploy/Caddyfile`.
* Restrict who can reach the admin hostname if possible (VPN or IP allow-list at the firewall or in Caddy).
* A separate staging environment that uses `pnpm demo`-style fictional data for training and trials.

## 8. Without Docker (Windows or Linux)

Install Node 22, PostgreSQL 17 and Caddy; create the database and user; export the variables from `.env.production` (plus `NODE_ENV=production`, `COOKIE_SECURE=true`, `DATABASE_URL`, and `DIRECT_URL` — the same value as `DATABASE_URL` unless you put PgBouncer in front of this Postgres too); then run `pnpm install --frozen-lockfile && pnpm build`, `pnpm exec prisma migrate deploy`, `node apps/api/dist/seed/run.js`, and `node apps/api/dist/main.js` under a service manager. Build the apps with an **empty** `VITE_API_URL` so they call the same origin, copy `apps/*/dist` to the Caddy roots, and use `deploy/Caddyfile`. `node deploy/verify-prod.mjs` checks the API side.

## 9. Files

`deploy/Dockerfile` (api and web images) · `deploy/docker-compose.prod.yml` · `deploy/Caddyfile` · `deploy/backup.sh` · `deploy/gen-secrets.mjs` · `deploy/.env.production.example` · `deploy/verify-prod.mjs` · `apps/api/src/seed/create-admin.ts` · `.dockerignore`.
