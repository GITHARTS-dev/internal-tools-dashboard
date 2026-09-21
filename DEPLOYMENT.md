# Deployment runbook — Azure Static Web Apps + Supabase

Everything that can be built without live credentials is built and tested. This
file is what remains, in order, with the exact commands.

Nothing here has been run. No Azure resource, Supabase project or Teams channel
exists yet.

```
GitHub push
  └─ GitHub Actions
      ├─ Vite client  →  Azure Static Web Apps        (free)
      └─ Hono API     →  SWA managed Functions        (free, included)
                              └─ Supabase Postgres    (free)

Sign-in:   SWA built-in auth, Entra ID — free, no domain required
Reminders: a scheduled GitHub Actions workflow calls POST /api/reminders/run
```

---

## What you actually have to create

| Thing | How | Cost |
|---|---|---|
| Supabase project | supabase.com → New project | Free tier |
| Azure Static Web App | Portal → Create → Static Web App → **Free** plan | Free |
| Entra app registration | Portal → Entra ID → App registrations | Free |
| Teams webhook | Teams → channel → Workflows | Free |

The Functions app, its routes and the HTTPS certificate are all created by the
deploy. There is nothing to click for those, and **no domain is needed** —
Entra sign-in attaches to the `*.azurestaticapps.net` hostname.

---

## 1. Supabase

Create the project and keep the database password somewhere safe; it appears in
both connection strings below.

**Project Settings → Database → Connection string** gives you two URIs. You need
both, and using the wrong one in the wrong place is the most likely thing to go
wrong here:

| Which | Port | Used for | Why |
|---|---|---|---|
| **Direct** | 5432 | migrations | A migration transaction needs one session held across statements. |
| **Transaction pooler** | 6543 | the running app | Every Function instance opens its own connection; without the pooler a handful of concurrent requests exhausts Postgres' connection limit. |

Apply the schema from your machine:

```bash
DATABASE_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
  npm run migrate:pg
```

Add `-- --dry-run` to see what it would apply first. It is idempotent: it
tracks what has run in a `schema_migrations` table, so running it again after
adding a migration applies only the new one.

**Do not** load `seed/dev-seed.sql` into this database. Those rows are
fictional.

### If you share an existing Supabase project

Prefer a **separate project**. This app's tables have plain names like `tools`,
`settings` and `audit_log`, and the migrations create them in the `public`
schema. Run them in a project that already has other tables and a name
collision either fails the migration or, worse, succeeds against someone else's
table. Check how many free projects your Supabase organisation allows before
assuming you can add one; if it is at its limit, ask whoever owns it rather than
squeezing this into the timesheet app's database.

### On the free tier pausing

Supabase pauses a free project after a period of inactivity — I believe about a
week, but check the current terms. The daily reminder run queries the database,
so it should keep the project awake on its own. Worth knowing about rather than
discovering when reminders go quiet.

---

## 2. Entra app registration

This is what restricts sign-in to your company. Without it, Static Web Apps'
pre-configured Entra provider accepts **any** Microsoft account, which is not
what you want in front of company spend.

Portal → **Microsoft Entra ID → App registrations → New registration**:

- Name: `Tools dashboard`
- Supported account types: **Accounts in this organizational directory only**
- Redirect URI: **Web** → `https://<your-site>.azurestaticapps.net/.auth/login/aad/callback`

You will not know the hostname until after the first deploy, so either deploy
once first, or come back and add the redirect URI afterwards.

Then:
1. **Certificates & secrets → New client secret.** Copy the *value* immediately;
   it is never shown again.
2. Note the **Application (client) ID** and the **Directory (tenant) ID** from
   the Overview page.
3. In [staticwebapp.config.json](staticwebapp.config.json), replace
   `AAD_TENANT_ID_PLACEHOLDER` with the tenant ID. It is in the issuer URL, not
   a secret, so it belongs in the committed file.

---

## 3. The Static Web App

Portal → **Create a resource → Static Web App**:

- Plan type: **Free**
- Deployment: **GitHub**, pointing at this repo and the branch you deploy from
- Build presets: **Custom**, and leave the paths blank — the workflow in this
  repo builds everything and uploads the result, so Azure's own build step is
  skipped

Azure will offer to add its own workflow file. This repo already has
[.github/workflows/azure-deploy.yml](.github/workflows/azure-deploy.yml), which
runs the tests before deploying. Delete the generated one and keep this.

Copy the **deployment token** (Overview → Manage deployment token).

### Configuration

**Settings → Environment variables**, for the Production environment:

| Name | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** URI, port **6543** |
| `AAD_CLIENT_ID` | Application (client) ID |
| `AAD_CLIENT_SECRET` | The client secret value |
| `REMINDER_TOKEN` | A long random string you generate |
| `TEAMS_WEBHOOK_URL` | From step 5 (optional; can also live in Settings) |
| `APP_ENV` | `production` |

Generate the reminder token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`APP_ENV=production` is not decorative: it disables the endpoints that wipe or
reload demo data.

### GitHub repository secrets

**Repo → Settings → Secrets and variables → Actions:**

| Secret | Value |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | The deployment token |
| `APP_URL` | `https://<your-site>.azurestaticapps.net` |
| `REMINDER_TOKEN` | The same string as above |

---

## 4. Deploy

Push to the deployment branch, or run the workflow by hand from the Actions tab.
It runs `npm test` first, so a broken build does not reach production.

Then check it:

```bash
curl https://<your-site>.azurestaticapps.net/api/health
```

Two things are worth verifying deliberately:

1. **Open the site in a private window.** You should be redirected to a
   Microsoft sign-in. If you get the app instead, auth is not applied — stop and
   fix it before entering real data.
2. **Try an account outside your tenant**, if you have one. It should be
   refused. If it is let in, the app registration is multi-tenant.

Seed the exchange rates once (they are refreshed daily after that):

```bash
curl -X POST "https://<your-site>.azurestaticapps.net/api/fx/refresh?from=2024-01" \
     -H "x-reminder-token: <REMINDER_TOKEN>"
```

---

## 5. Teams reminders

The Teams channel is fully coded. It needs one URL and nothing else — no app
registration, no admin consent.

1. In Teams, open the channel reminders should go to.
2. `⋯` beside the channel name → **Workflows**.
3. Template: **"Post to a channel when a webhook request is received"**.
4. Name it, confirm the team and channel, finish.
5. Copy the URL.

That URL is a password — anyone holding it can post into the channel. Put it in
the SWA environment variables as `TEAMS_WEBHOOK_URL`, or paste it into the app's
own Settings page.

Then press **Send test** beside Teams in Settings. A card should arrive within
seconds. The test records nothing, so it cannot consume a real reminder's
dedupe key.

### What actually gets sent, and when

The scheduled workflow runs once a day. **That is the check, not the message.**
It asks "is anything crossing a reminder threshold today?" and posts only when
the answer is yes:

- A renewal is 60 / 30 / 14 / 7 / 3 / 1 days away (configurable in Settings).
- A payment is due soon, or is overdue.
- The last day to cancel without paying for another period is approaching.
- A tool is missing data, or has seats nobody uses.

On a quiet day it posts nothing at all. The `notification_log` table's unique
`dedupe_key` is what guarantees the same alert never goes out twice, per
channel.

To see exactly what would fire on any date without sending anything, use
Settings → **Preview reminders**, or:

```
GET /api/reminders/dry-run?date=2026-10-01
```

To fire it by hand: Actions tab → **Send due reminders** → Run workflow.

**The schedule only runs from the repository's default branch.** GitHub ignores
a `schedule:` trigger on any other branch, so `reminders.yml` does nothing until
it is on `main`. Manual runs work from any branch, which is enough for testing;
merge to `main` before relying on the daily check.

### Why the schedule is not in Azure

Static Web Apps' managed Functions are HTTP-only — they have no timer trigger.
The options were a separate Function App (another resource to run and watch) or
a scheduled workflow calling the endpoint. The workflow is free, sits next to
the code, logs what it sent, and can be run manually in one click.

That does mean one endpoint is reachable without an interactive sign-in, which
is why `/api/reminders/run` carries its own shared secret. It is excluded from
the Entra rule in `staticwebapp.config.json` and checks `x-reminder-token` with
a constant-time comparison. Without `REMINDER_TOKEN` set, the guard is inert —
fine locally, wrong in production. **Set it.**

---

## 6. Email (optional, still inert)

The email channel exists and stays skipped until credentials are set. Add these
as SWA environment variables:

**Microsoft Graph** — sends from your own M365 domain:

```
EMAIL_PROVIDER=graph
MS_TENANT_ID=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
```

Needs an app registration with `Mail.Send` application permission and admin
consent — which is why Teams ships first.

**Resend** — faster, external vendor:

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=...
```

Then set "Send email from" and "Send email to" in Settings.

---

## Local development

Unchanged by any of this, and still needs no cloud account:

```bash
npm install
npm run db:reset    # rebuild .data/dev.sqlite and load the demo data
npm run dev         # API on :8787, client on :5173
```

Local runs on SQLite so it stays instant and offline. The fidelity that costs is
bought back in `tests/postgres.test.ts`, which runs the whole API against real
Postgres — PGlite, Postgres compiled to WASM — on every `npm test`. That is what
catches dialect differences before they reach Supabase.

To point local development at a real Postgres instead:

```bash
DATABASE_URL="postgresql://..." npm run dev:api
```

---

## Rollback

Static Web Apps keeps previous deployments; the reliable rollback is to revert
the commit and let the workflow redeploy.

The database is separate. Supabase free tier has daily backups with limited
retention — check what yours actually has **before** you need it. Nothing in
this app hard-deletes: cancelled tools are archived and keep their payment
history, so the common "undo" is a status change, not a restore.

---

## Checklist

- [ ] Supabase project created, password saved
- [ ] `npm run migrate:pg` against the **direct** URI (5432) succeeds
- [ ] Entra app registration, single-tenant, secret copied
- [ ] Tenant ID pasted into `staticwebapp.config.json`
- [ ] Static Web App created on the **Free** plan, deployment token copied
- [ ] Azure-generated workflow deleted, this repo's kept
- [ ] SWA environment variables set (`DATABASE_URL` on the **pooler**, 6543)
- [ ] GitHub secrets set (`AZURE_STATIC_WEB_APPS_API_TOKEN`, `APP_URL`, `REMINDER_TOKEN`)
- [ ] Deploy green, `/api/health` responds
- [ ] Redirect URI added to the app registration
- [ ] **Private window redirects to sign-in** — not straight into the app
- [ ] An account outside the tenant is refused
- [ ] `POST /api/fx/refresh?from=2024-01` run once
- [ ] Teams webhook set, **Send test** produces a card
- [ ] "Send due reminders" workflow run manually, card arrives
