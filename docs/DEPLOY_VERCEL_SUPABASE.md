# Deploying to Vercel + Supabase

This is an alternative to `docs/DEPLOYMENT.md` (self-hosted Docker on your own server). Read that
file's **"Go-live gates"** section first — nothing about *where* the app runs changes whether it is
safe to put real students on it. This document only covers packaging the same application for
Vercel (hosting) + Supabase (PostgreSQL), and it has not been run against a live Vercel/Supabase
project from this development environment — smoke-test every step below, same as the Docker path.

## 1. Why this looks different from the Docker setup

The Docker deployment runs one long-lived Node process behind Caddy, all on one host. Vercel has no
such thing — it runs your code as short-lived serverless functions, and a 4-container Docker Compose
stack doesn't translate directly. The pieces map like this:

| Docker Compose | Vercel + Supabase |
|---|---|
| `db` container (Postgres) | A Supabase project (managed Postgres) |
| `api` container (`node dist/main.js`, listens forever) | `apps/api` as its own Vercel project — a serverless function that boots Nest once per cold start and reuses it (`apps/api/src/serverless.ts`) |
| `web` container (Caddy serving 3 static apps + proxying `/api/*`) | Three separate Vercel projects (`admin`, `student-portal`, `reader`), each with a `vercel.json` rewrite that proxies `/api/*` to the API project — same job Caddy was doing, done by Vercel's edge instead |
| `backup` container (nightly `pg_dump`) | Supabase's own automatic backups (check your plan's retention) |

Four Vercel projects total, from one repository, each with its own **Root Directory** setting.

### What is genuinely weaker here than the Docker setup — be aware of these, don't just copy-paste

* **Rate limiting is per-instance, not global.** `ThrottlerModule` keeps its counters in memory
  (`apps/api/src/app.module.ts`). On a single long-lived process that's a real per-IP/per-minute
  limit. On Vercel, each concurrent cold-started function instance has its *own* counters, so the
  effective limit under load is "per-instance limit × however many instances Vercel spun up" — looser
  than configured, not broken, but don't treat `THROTTLE_LOGIN_LIMIT` as a hard global guarantee.
* **Cold starts.** The first request after idle time pays Nest's full module-graph boot cost
  (roughly comparable to `pnpm live`'s own API startup time). Subsequent requests to the *same* warm
  instance reuse it (see `getApp()` caching in `src/serverless.ts`).
* **Supabase's pooled connection has a small connection budget.** Each serverless invocation can open
  its own DB connection; `connection_limit=1` in `DATABASE_URL` (below) keeps any one function
  instance from hogging the pool, but a traffic spike with many concurrent cold instances can still
  exhaust a free-tier Supabase pool. Fine for a pilot/demo; revisit before real load.
* **No single place that proxies all three apps under one hostname.** The Docker setup had Caddy
  terminating `admin.`/`wallet.`/`reader.` on one box. Here each frontend is its own Vercel project
  with its own `*.vercel.app` domain (or custom domain) — functionally equivalent for cookies (each
  is same-origin with the API through its own rewrite), just three separate deployments to manage
  instead of one.

Nothing above blocks a pilot or a final-year-project demo; it's what to revisit before trusting it
with real students, same spirit as the "Go-live gates" in `docs/DEPLOYMENT.md`.

## 2. Set up Supabase

1. Create a project at supabase.com (pick a region close to where Vercel will run your functions —
   Vercel defaults to `iad1`/US East unless you change it).
2. Project Settings → Database → Connection string. You need **two** different connection strings:
   * **Pooled** (Transaction mode, port **6543**) — for `DATABASE_URL`.
   * **Direct** (port **5432**) — for `DIRECT_URL`, used only to run migrations.
3. `prisma/schema.prisma` already expects both:
   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")
     directUrl = env("DIRECT_URL")
   }
   ```
4. Append `?pgbouncer=true&connection_limit=1&sslmode=require` to the pooled URL, and
   `?sslmode=require` to the direct one. See `deploy/.env.vercel.example` for the exact shape.

No schema changes were needed beyond that — the migrations in `prisma/migrations/` are plain
tables/constraints/triggers with no extensions or superuser-only statements, so they run on
Supabase's managed Postgres unmodified.

## 3. Create the four Vercel projects

From the repo root, for each app: **Add New → Project → Import this repository**, then set
**Root Directory** to the app's folder before the first deploy. Create them in this order (the
frontends' `vercel.json` needs the API project's URL):

1. **API** — Root Directory `apps/api`. Vercel will read `apps/api/vercel.json`, which already has
   the right `buildCommand` (builds the workspace, runs `nest build`) and function config.
   Note the project's stable URL (`https://<project-name>.vercel.app` — fixed once the project
   exists, before you've even deployed).
2. **Admin** — Root Directory `apps/admin`.
3. **Student wallet** — Root Directory `apps/student-portal`.
4. **Reader** — Root Directory `apps/reader`.

For steps 2–4: open `apps/<app>/vercel.json` and replace the placeholder
`https://kiu-uscas-api.vercel.app` in the `rewrites` destination with the real API project URL from
step 1, then commit. (If you'd rather not edit the file, create the API project first with that
exact name — `kiu-uscas-api` — and the placeholder already matches.)

## 4. Environment variables

**API project** — Project Settings → Environment Variables, set for Production (and Preview if you
want preview deploys to work): everything in `deploy/.env.vercel.example`. Generate the secret
values with:
```bash
node deploy/gen-secrets-vercel.mjs
```
Fill in `DATABASE_URL` / `DIRECT_URL` from Supabase (step 2). Set these for **Production and
Preview** — `prisma generate` (part of the build) needs `DATABASE_URL`/`DIRECT_URL` to be *defined*
even though it doesn't connect to them.

**Admin / student-portal projects** — nothing to set. `apps/admin/.env.vercel` and
`apps/student-portal/.env.vercel` already commit `VITE_API_URL=` (empty) for the `vercel` Vite mode
that each project's `vercel.json` `buildCommand` uses — empty means "call whatever origin served
this page," which is exactly right once the `/api/*` rewrite makes that origin proxy to the API.

**Reader project** — nothing to set; the reader app takes its server address as runtime input at
setup time (same as the Docker deployment), not a build-time env var.

## 5. Run migrations (not part of the Vercel build, on purpose)

Running `prisma migrate deploy` from inside a Vercel build is risky: concurrent/preview deployments
could race each other against the same database. Run it from your own machine instead, pointed at
Supabase's **direct** URL:

```bash
DIRECT_URL="<supabase direct connection string>" DATABASE_URL="<same, or the pooled one>" \
  pnpm exec prisma migrate deploy
```

Do this once before the first deploy, and again after `git pull`-ing any change that touches
`prisma/migrations/`.

## 6. Deploy and create the first administrator

Deploy all four projects (push to the branch each is tracking, or `vercel --prod` from each app's
directory). Then, from your own machine, create the first admin against the same Supabase database:

```bash
DATABASE_URL="<supabase connection string>" \
  node apps/api/dist/seed/create-admin.js you@example.org "Your Name"
```
(Run `pnpm turbo run build --filter=@kiu/api` first if `apps/api/dist` doesn't exist locally.) This
prints a one-time password — there are no default accounts. Sign in at the admin project's URL; you
will be forced to enrol an authenticator app before anything else, same as the Docker path.

## 7. Smoke test

* `https://<api-project>.vercel.app/api/v1/health` returns 200.
* Sign in at the admin URL, complete MFA enrolment.
* Issue a card to a test student, activate it in the wallet app, confirm the Access/Audit logs.
* Confirm the browser's dev tools show the access-token cookie on the admin domain (not the API
  domain) — if you see "Authentication required" right after a successful login, the most likely
  cause is the `/api/*` rewrite destination still pointing at the wrong API project URL (step 3).

## 8. Files

`apps/api/vercel.json`, `apps/api/api/[...path].js`, `apps/api/src/serverless.ts` ·
`apps/admin/vercel.json`, `apps/admin/.env.vercel` · `apps/student-portal/vercel.json`,
`apps/student-portal/.env.vercel` · `apps/reader/vercel.json` ·
`deploy/.env.vercel.example`, `deploy/gen-secrets-vercel.mjs` · `prisma/schema.prisma` (`directUrl`).
