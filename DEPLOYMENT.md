# Server Deployment

Backend (Express + Prisma 7) deployment reference for the Personal AI Job Tracker.

## Environments

| Tier | Branch | Render Service | URL | Supabase Project |
|---|---|---|---|---|
| Production | `main` | `<prod-service-name>` (TODO) | `<prod-render-url>` (TODO) | prod |
| Staging | `dev` | `jobtracking-server-staging` | `https://jobtracker-staging.onrender.com` | staging |
| Local | working tree | — | `http://localhost:5000` | dev |

Each Render service auto-deploys on push to its tracked branch. Each tier has its **own Supabase project** — schemas may match, but databases are fully isolated.

## Environment Variables

Set in **Render → Service → Environment**. Local mirrors live in `server/.env.local` (dev DB) and `server/.env.staging` (staging DB, used only for migrations from local).

| Key | Notes |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler**, port `6543`, with `?pgbouncer=true`. Runtime queries. |
| `DIRECT_URL` | Supabase **session pooler**, port `5432`. Migrations only. |
| `JWT_SECRET` | **Must be unique per environment.** Generate with `openssl rand -base64 48`. Never share between prod and staging. |
| `GEMINI_API_KEY` | Google AI Studio. Can be shared across envs or split per env. |
| `FIRECRAWL_API_KEY` | Firecrawl dashboard. Shared with prod currently; consider splitting. |
| `CLIENT_ORIGIN` | Frontend URL for that environment. **Exact match required for CORS** (no trailing slash, include `https://`). |
| `NODE_ENV` | `production` on both prod and staging Render services. |

### `CLIENT_ORIGIN` values

| Env | Value |
|---|---|
| Production | `<prod-vercel-domain>` (TODO) |
| Staging | `https://job-tracker-git-dev-piyapathongron-3507s-projects.vercel.app` |
| Local | `http://localhost:3000` |

## Prisma 7 Datasource Config

Connection URLs are **not** in `schema.prisma`. They live in `prisma.config.ts`:

```ts
datasource: { url: process.env["DIRECT_URL"] }
```

`dotenv` loads `.env.local` at the top of that file. To run Prisma against a different env file (e.g. staging), prepend `dotenv-cli` — its env vars win because `dotenv` won't override already-set values.

## Running Migrations

### Local dev DB

```bash
cd server
npx prisma migrate dev --name <descriptive_name>
```

### Staging DB (from local)

```bash
cd server
pnpm dlx dotenv-cli -e .env.staging -- npx prisma migrate deploy
```

`migrate deploy` only applies existing migrations — never use `migrate dev` or `migrate reset` against staging or prod.

### Production DB

Same pattern as staging, with a `.env.production` (not committed) or directly via Render shell. Coordinate with the team — R0 risk level per `CLAUDE.md`.

### Prisma 7 quirks

- `migrate reset` is blocked for AI agents without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` env var set to verbatim user consent.
- `migrate dev` refuses to run in non-TTY environments when the migration is destructive. Workaround: hand-write the SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`, then `prisma migrate deploy`.

## Deployment Flow

```
feature branch  →  PR into dev  →  staging Render auto-deploys  →  QA
                                                                    ↓
                                                          PR dev → main
                                                                    ↓
                                                       prod Render auto-deploys
```

Hotfixes: branch off `main`, PR into `main`, back-merge to `dev`.

## CI

`.github/workflows/ci.yml` runs on push/PR to `main` and `dev`:
1. `pnpm install --frozen-lockfile`
2. `pnpm build` (runs `prisma generate && tsc`)

## Secret Rotation

If a secret leaks (chat, screenshot, git history), rotate **immediately**:

- **`JWT_SECRET`** — generate new with `openssl rand -base64 48`, update Render env, redeploy. Active sessions invalidate.
- **`FIRECRAWL_API_KEY`** — Firecrawl dashboard → revoke + create new → update **all** Render services + local `.env.local`.
- **`GEMINI_API_KEY`** — Google AI Studio → revoke + create new → update all services.
- **Supabase DB password** — Supabase → Project Settings → Database → Reset password → re-copy `DATABASE_URL` + `DIRECT_URL` into Render and local env files.

## Render Free Tier Notes

- Services spin down after **15 min of inactivity**.
- First request after spin-down takes **30–60 s** (cold start).
- For staging this is acceptable. If prod ever spins down, upgrade the prod service tier.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Could not find Prisma Schema` | Running Prisma command from wrong directory. `cd server/` first. |
| Migration hangs against Supabase | `DIRECT_URL` not set, or pointing at the pgBouncer pooler instead of the session pooler. |
| `Access-Control-Allow-Origin` error from frontend | `CLIENT_ORIGIN` doesn't match the frontend URL exactly. |
| `401` on every protected route | `JWT_SECRET` mismatch between the service that issued the token and the one verifying it. Common when env vars get rotated only on one tier. |
| Backend 500s after deploy | Check Render logs. Usually a missing env var or DB connectivity failure. |
