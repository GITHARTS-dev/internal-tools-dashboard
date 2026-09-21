# Deployment and delivery runbook

Everything that can be built before we have a Teams channel and a Cloudflare
account is built. This file is the list of what is left, in the order it needs
doing, with the exact commands.

Nothing here has been run yet. Deployment is deliberately on hold.

---

## 1. Teams reminders

The Teams channel is fully coded. It needs one URL and nothing else: no app
registration, no admin consent, no credentials.

### Get the webhook URL

1. In Teams, open the channel reminders should go to.
2. `⋯` beside the channel name → **Workflows**.
3. Pick the template **"Post to a channel when a webhook request is received"**.
4. Name it something like `Tools dashboard reminders`, confirm the team and
   channel, and click through to the end.
5. Copy the URL it gives you. It looks like
   `https://prod-XX.westus.logic.azure.com:443/workflows/...`

That URL is a password. Anyone holding it can post into the channel.

### Put it in

**For local use**, paste it into Settings → Teams webhook URL, then press
**Send test** next to Teams in "Where reminders go". A card should appear in the
channel within a second or two. The test records nothing, so it cannot suppress
a real reminder.

**For the deployed Worker**, prefer a secret over the settings row:

```bash
wrangler secret put TEAMS_WEBHOOK_URL --env production
```

The code checks the settings value first and falls back to the environment
variable, so either works and the secret keeps the URL out of the database.

### What gets sent

- **Daily**, at 03:00 UTC (08:30 IST): one card listing everything that newly
  crossed a reminder threshold. One message per run, not one per alert.
- **Weekly**, on the digest weekday: everything on the horizon.
- Nothing is sent twice. The `notification_log` table's unique `dedupe_key` is
  what guarantees it, per channel.

Preview any day's output without sending, using Settings → Preview reminders,
or `GET /api/reminders/dry-run?date=2026-10-01`.

---

## 2. Email reminders (optional, still inert)

The email channel exists and stays skipped until credentials are set. Two
providers are supported.

**Microsoft Graph** — sends from our own M365 domain, no new vendor:

```bash
wrangler secret put EMAIL_PROVIDER --env production   # value: graph
wrangler secret put MS_TENANT_ID --env production
wrangler secret put MS_CLIENT_ID --env production
wrangler secret put MS_CLIENT_SECRET --env production
```

This one does need an app registration with `Mail.Send` application permission
and admin consent, which is why Teams ships first.

**Resend** — faster to set up, external vendor:

```bash
wrangler secret put EMAIL_PROVIDER --env production   # value: resend
wrangler secret put RESEND_API_KEY --env production
```

Then set "Send email from" and "Send email to" in Settings.

---

## 3. Cloudflare

### What has to exist

| Thing | How it gets made | Cost |
|---|---|---|
| Cloudflare account | Sign up | Free |
| **D1 database** (`tools_db`) | `wrangler d1 create tools_db` | Free tier: 5GB, ~5M reads/day |
| **Worker** | Created by `wrangler deploy` — nothing to click | Free tier: 100k requests/day |
| Cron trigger | Registered by the deploy, from `wrangler.jsonc` | Free |
| Static assets (the React app) | Uploaded by the same deploy | Free |
| **A domain** | Add an existing one, or buy one | ~£10/year |
| Cloudflare Access application | Zero Trust dashboard | Free for small teams |

Only two of those are things you create by hand before deploying: the **D1
database** and the **domain**. The Worker, its cron and its assets are all
products of `wrangler deploy`.

The domain is needed only for sign-in — see [Sign-in](#sign-in). You can deploy
and test on `*.workers.dev` first, as long as there is no real data in it.

This app's usage is a handful of people and one cron run a day, so the free
tiers are not close to being a constraint.

### One-time setup

```bash
npx wrangler login

# Create the production database. This prints a database_id.
npx wrangler d1 create tools_db
```

Paste that id into `wrangler.jsonc`, into the **`env.production`** block's
`database_id` field, replacing `REPLACE_WITH_REAL_D1_ID`. Leave the top-level
placeholder alone: keeping them separate is what stops local development
writing to the live database.

Apply the schema to the remote database:

```bash
npx wrangler d1 migrations apply tools_db --remote --env production
```

Do **not** run `seed:local` against production. It loads the fictional demo
data.

### Deploy

```bash
npm run build          # typecheck + build the client into dist/client
npx wrangler deploy --env production
```

Check it before trusting it:

```bash
curl https://<your-worker>.workers.dev/api/health
```

The cron trigger is registered by the deploy. To prove the scheduled job works
without waiting for 03:00 UTC, use the Cloudflare dashboard's "Trigger
scheduled event", or locally:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

### Sign-in

There is no authentication in the app. Until there is, Cloudflare Access goes in
front of the whole Worker.

**This is the step that needs a domain.** An Access self-hosted application is
defined by a hostname in a zone *you* own on Cloudflare. `*.workers.dev` is
Cloudflare's own zone, not yours, so a policy cannot be attached to it. In
practice that means:

1. Add a domain to Cloudflare (an existing one, or buy one — a `.com` is roughly
   £10/year, and this is the only unavoidable cost in the whole setup).
2. Point the Worker at a hostname on it, e.g. `tools.ourdomain.com`, via
   Workers → the Worker → Settings → Domains & Routes → Add custom domain.
3. Zero Trust → Access → Applications → Add → Self-hosted, using that hostname.
4. Identity provider: Azure AD / Entra ID, so people sign in with the M365
   account they already have.
5. Policy: allow the specific emails, or the Entra group, that should get in.

Confirm the workers.dev limitation against current Cloudflare docs before buying
anything — it is the kind of thing they change.

Access is free for small teams. **Until that policy exists, do not deploy with
real data**: a bare `workers.dev` URL is public to anyone who has it, and this
app has no login of its own.

### Rollback

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

D1 has its own time-travel restore, separate from Worker rollback:

```bash
npx wrangler d1 time-travel restore tools_db --timestamp <iso-8601> --env production
```

---

## 4. Exchange rates in production

Rates come from the ECB's public API. No key, no account, no cost.

After the first deploy, seed a couple of years of history once:

```bash
curl -X POST "https://<your-worker>.workers.dev/api/fx/refresh?from=2024-01"
```

After that the daily job keeps them current on its own, as long as Settings →
"Fetch exchange rates automatically" is on. It refreshes a trailing three-month
window, because the ECB revises recent months and publishes a month only once
that month has ended.

If the ECB is unreachable, the reminder run still happens — rates are refreshed
first and a failure there is logged and stepped over.

---

## 5. If we go with Supabase + Azure instead

The alternative discussed. What it would cost us, honestly:

- The API is a Cloudflare Worker over D1 (SQLite). Moving means porting the
  schema and queries to Postgres and rewriting the API host.
- `src/server/repo/db.ts` is the only place that touches the database, and it is
  a deliberately narrow interface. That is the seam a port would go through, so
  the work is one adapter rather than an application rewrite — but the SQL
  dialect differences are still real.
- Static Web Apps' managed functions are HTTP-only, so the daily job needs a
  separate Function App with a timer trigger. On Cloudflare the cron is one line
  of config.
- Check Supabase's current free-tier terms before committing: projects pausing
  after a period of inactivity would silently stop reminders, which is the one
  failure this product cannot have.
- Entra sign-in is more natural on Azure. Cloudflare Access does M365 sign-in
  too, and is free for small teams, so this is a smaller advantage than it looks.

Recommendation: stay on Cloudflare unless something else forces the move.

---

## Checklist

- [ ] Teams workflow created, URL copied
- [ ] URL pasted into Settings (local) — **Send test** produces a card
- [ ] Cloudflare account created
- [ ] `wrangler login`
- [ ] `wrangler d1 create tools_db`, id pasted into `env.production`
- [ ] `wrangler d1 migrations apply tools_db --remote --env production`
- [ ] `wrangler secret put TEAMS_WEBHOOK_URL --env production`
- [ ] Domain added to Cloudflare, custom hostname pointed at the Worker
- [ ] Cloudflare Access policy in place, tested with a second account
- [ ] `npm run build && wrangler deploy --env production`
- [ ] `/api/health` responds
- [ ] `POST /api/fx/refresh?from=2024-01` run once
- [ ] Scheduled event triggered manually, card arrives in Teams
