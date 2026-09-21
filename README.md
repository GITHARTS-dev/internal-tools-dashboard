# Internal Tools &amp; Subscriptions Dashboard

A ledger and reminder system for the SaaS tools a company pays for — Canva,
M365, Clockify and the rest — so nobody has to remember who owns what, when it
renews, or what it costs.

It answers three questions that currently have no home:

1. **What do we pay for, and who owns it?** Every tool, past and present, with
   its cost, owner, seats, billing details and full change history.
2. **What did we actually pay?** A payment ledger that outlives the
   subscription, so "what did Canva cost us last year" stays answerable.
3. **What is about to bite us?** A daily check that posts to Teams before a
   renewal, before a payment is due, and — the one people actually miss —
   before the last day to cancel without being charged for another period. On a
   day when nothing is due, it posts nothing.
4. **What does all of it come to?** A cost summary in one currency, splitting
   what we buy from what it costs to run our own products.

> **Status: not deployed.** This runs entirely on your own machine while the
> features and design are reviewed. It needs no cloud account, no credit card
> and no sign-up. When you are ready, [DEPLOYMENT.md](DEPLOYMENT.md) is the
> runbook for Azure Static Web Apps + Supabase.

## Running it

```bash
npm install
npm run db:reset   # create the local database and load demo data
npm run dev        # API on :8787, app on http://localhost:5173
```

Open <http://localhost:5173>. The demo data is deliberately messy: an overdue
payment, a bill due this week, a cancellation window that has already closed,
tools with idle seats, records with no owner, two currencies, and cancelled
tools whose history survives.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app and API locally |
| `npm test` | Unit and API tests |
| `npm run test:e2e` | Browser smoke test (needs `npm run dev` running) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | Production build |
| `npm run db:reset` | Recreate the local database and reload demo data |
| `npm run seed:generate` | Regenerate the demo dataset |
| `npm run migrate:pg` | Apply migrations to Supabase (needs `DATABASE_URL`) |

## What costs money

Nothing. At this size the whole stack sits inside free tiers:

- **Data** is Supabase Postgres on the free tier. Locally it is a SQLite file,
  so development needs no account at all.
- **App and API** are an Azure Static Web App on the Free plan, with the API as
  a managed Azure Function included in it. No separate resource, no domain
  required, HTTPS and Entra sign-in included.
- **The scheduler** is a GitHub Actions workflow, free on any plan.
- **Teams reminders** use an incoming webhook, which is free.
- **Email** goes over HTTP via Microsoft Graph (free with an M365 tenant you
  already pay for) or Resend (~3,000/month free).

A few hundred tools and one daily run use a fraction of a percent of that. The
one thing to watch is Supabase pausing an idle free project — the daily run
queries the database, which should keep it awake.

## How it works

```
Browser ──► Static Web Apps ──┬── React SPA (static files)
            (Entra sign-in)   └── /api/* ──► Azure Function
                                             └── Hono API ──► Postgres

GitHub Actions (daily) ──► POST /api/reminders/run ──► console / Teams / email
```

The Hono app in `src/server/index.ts` knows nothing about its host. Two thin
adapters sit beside it — `azure.ts` for production, `dev.ts` for local work —
and neither knows anything about the routes.

### The alert engine

`src/shared/alerts.ts` exports one pure function, `computeAlerts()`. It is the
**only** definition of "needs attention" in the codebase, and the dashboard
API, the UI badges and the reminder job all call it. The screen can never show
a tool as fine while the reminder job considers it overdue, because there is
nowhere else for the two to disagree.

| Alert | Fires when |
|---|---|
| `payment_overdue` | past its due date and unpaid — then chased weekly, not daily |
| `payment_due_soon` | due within a configured lead window |
| `renewal_upcoming` | renewal within 60 / 30 / 14 / 7 / 3 / 1 days |
| `notice_deadline` | the last day to cancel before auto-renewal |
| `missing_data` | an active tool with no owner, no cost or no renewal date |
| `seats_underused` | paid seats sitting idle |

Every alert carries a `dedupe_key` naming its lead step. The notification log
has a UNIQUE index on it, which is what stops someone being told about the same
renewal every morning for sixty days.

### Previewing reminders

`GET /api/reminders/dry-run?date=2026-11-01`, or the **Preview reminders** panel
in Settings, shows exactly which reminders would fire on any date. It runs the
same code path the scheduled job uses — only a `dryRun` flag differs — and sends
and records nothing. It is always safe to run, including against real data.

### Things that are deliberate

- **Money is stored as integers** in minor units with an explicit currency.
  Never floats: `0.1 + 0.2 !== 0.3` is not an acceptable property for something
  that decides whether a bill is paid.
- **Amounts keep their own currency** everywhere except where a single combined
  figure is genuinely needed (the cost summary). There, each amount is converted
  at the ECB reference rate of the month it belongs to — never today's rate —
  so a past year's total is the same number every time it is asked for. Anything
  with no usable rate is left out of the total and named on screen rather than
  guessed at.
- **Nothing is deleted.** Cancelled tools are archived and keep their payment
  history and audit trail. That is what makes this a ledger.
- **"Overdue" is derived, not stored**, so a stale row can never disagree with
  the engine.
- **Every mutation writes an audit row** with a field-level diff.
- **Imports are previewed first.** `POST /api/import` reports what it would do
  row by row and writes nothing until an explicit second call with
  `?commit=true`.

## Getting your data in

Settings → **Import from a spreadsheet**. Download the template, fill it from
whatever list you have today, and check it before committing. Rows are matched
to existing tools by name, so re-importing an edited export updates in place
rather than creating duplicates.

## Configuration

Set as environment variables in the Static Web App, or in your shell locally.
Nothing secret belongs in a committed file.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase connection string. Unset locally, which selects SQLite. |
| `REMINDER_TOKEN` | Shared secret for `POST /api/reminders/run`, the one endpoint a machine calls. Inert when unset. |
| `APP_ENV` | `production` disables the demo-data controls. |
| `FEATURE_DOCUMENTS` | `true` enables contract/invoice records. Off by default, pending a decision on whether invoices are stored at all or only their amounts. |
| `TEAMS_WEBHOOK_URL` | Teams incoming webhook (can also be set in Settings). |
| `EMAIL_PROVIDER` | `graph`, `resend`, or unset. Unset means email stays inert. |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Microsoft Graph credentials. |
| `RESEND_API_KEY` | Resend API key. |

Reminder lead days, the business timezone, the digest day and the idle-seat
threshold are all editable in Settings.

Note: both supported email providers are HTTP APIs rather than SMTP, which
keeps the app deployable to environments that do not allow outbound SMTP.

## Our own products

Hosting, domains and APIs are things we pay a vendor for, so they are ordinary
tools. What makes them different is that they exist to keep one of *our*
products running — so an internal product is a bucket a tool can be attributed
to, and its running cost is the roll-up of those tools.

The consequence: a hosting renewal chases its owner through exactly the same
reminder path as a Canva renewal, with no new alerting code. Running cost is
subscription and licence cash only; there is nowhere to record staff time, on
purpose.

## Exchange rates

Monthly reference rates from the ECB's public API — no key, no account, no cost.
Settings → **Exchange rates** shows what is stored and fetches more. The daily
job keeps a trailing window current, because the ECB revises recent months and
publishes a month only once it has ended.

Only the cost summary needs them. Everything else stays in its own currency.

## Deploying later

Deliberately not done yet. **[DEPLOYMENT.md](DEPLOYMENT.md)** is the full
runbook: Supabase, the Entra app registration, Static Web Apps, secrets, the
Teams webhook, and what to verify before trusting it.

The shape:

- **Client and API** ship together from one commit to Azure Static Web Apps.
  The API is a managed Azure Function on the free tier — no separate resource.
- **Database** is Supabase Postgres. Migrations run from your machine against
  the direct connection; the app uses the transaction pooler.
- **Sign-in** is Static Web Apps' built-in Entra auth, applied to the static
  files and the API alike. It is free and needs no custom domain.
- **Reminders** fire from a scheduled GitHub Actions workflow, because managed
  Functions are HTTP-only and have no timer trigger.

The app has no access control of its own, so the sign-in must be in place before
real data goes in. `src/server/context.ts` has a single `actor()` function that
every audit row already flows through; wiring the signed-in identity into it is
a one-function change.

## Layout

```
migrations/      schema (numbered, run in order; one set for both engines)
seed/            demo data -- never run against a real deployment
src/shared/      types, validation, money, fx, dates, alerts, metrics, ceo, CSV
src/server/      Hono API, repository layer, notification channels, fx
src/server/azure.ts   the Azure Functions host
src/server/dev.ts     the local server
api/             what gets deployed as the Function (built, not hand-written)
src/client/      React app
tests/           unit and API tests, against both SQLite and Postgres
```

All database access goes through `src/server/repo/`, behind a narrow `Db`
interface with three implementations: Postgres for production, SQLite for local
work, and SQLite again for the tests. Nothing else writes SQL.

That seam is why moving off Cloudflare Workers cost one adapter and four
`ORDER BY` clauses rather than a rewrite. The migrations are a dialect-neutral
subset that both engines accept, and `tests/postgres.test.ts` runs the whole API
against real Postgres on every `npm test` to keep it that way.
