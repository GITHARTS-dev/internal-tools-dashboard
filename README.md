# Internal Tools &amp; Subscriptions Dashboard

A ledger and reminder system for the SaaS tools a company pays for — Canva,
M365, Clockify and the rest — so nobody has to remember who owns what, when it
renews, or what it costs.

It answers three questions that currently have no home:

1. **What do we pay for, and who owns it?** Every tool, past and present, with
   its cost, owner, seats, billing details and full change history.
2. **What did we actually pay?** A payment ledger that outlives the
   subscription, so "what did Canva cost us last year" stays answerable.
3. **What is about to bite us?** A daily job that pushes alerts before a
   renewal, before a payment is due, and — the one people actually miss —
   before the last day to cancel without being charged for another period.

> **Status: not deployed.** This runs entirely on your own machine while the
> features and design are reviewed. It needs no Cloudflare account, no credit
> card and no sign-up. See [Deploying later](#deploying-later).

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
| `npm run seed:generate` | Regenerate `seed/dev-seed.sql` |

## What costs money

Nothing. At this size the whole stack sits inside free tiers:

- **Data** is SQLite. Locally it is a file Wrangler manages; deployed it is
  Cloudflare D1, which is serverless — no instance to keep running, no hourly
  charge, and a free tier of 5 GB, 5 M row-reads/day and 100 k writes/day.
- **App and scheduler** are one Cloudflare Worker. The free tier covers
  100 k requests/day and cron triggers.
- **Teams reminders** use an incoming webhook, which is free.
- **Email** goes over HTTP via Microsoft Graph (free with an M365 tenant you
  already pay for) or Resend (~3,000/month free).

A few hundred tools and one daily cron use a fraction of a percent of that.

## How it works

```
Browser  ──►  Worker  ──►  SQLite / D1
              ├── React SPA (static assets)
              ├── Hono API  (/api/*)
              └── Cron handler ──► console / Teams / email
```

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
same code path the cron uses — only a `dryRun` flag differs — and sends and
records nothing. It is always safe to run, including against real data.

### Things that are deliberate

- **Money is stored as integers** in minor units with an explicit currency.
  Never floats: `0.1 + 0.2 !== 0.3` is not an acceptable property for something
  that decides whether a bill is paid.
- **No FX conversion.** Totals are per-currency. Applying today's rate to last
  year's invoice would make historical totals change on every page load.
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

Set in `wrangler.jsonc` under `vars`, or as secrets when deployed.

| Variable | Purpose |
|---|---|
| `FEATURE_DOCUMENTS` | `true` enables contract/invoice records. Off by default, pending a decision on whether invoices are stored at all or only their amounts. |
| `TEAMS_WEBHOOK_URL` | Teams incoming webhook (can also be set in Settings). |
| `EMAIL_PROVIDER` | `graph`, `resend`, or unset. Unset means email stays inert. |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Microsoft Graph credentials. |
| `RESEND_API_KEY` | Resend API key. |

Reminder lead days, the business timezone, the digest day and the idle-seat
threshold are all editable in Settings.

Note: a Worker cannot open a raw SMTP connection, so "send through our mailbox
with an app password" is not available. Both supported email providers are
HTTP APIs.

## Deploying later

Deliberately not done yet. When you want it, the steps are: create a Cloudflare
account, `wrangler d1 create tools_db`, paste the returned id into
`wrangler.jsonc`, apply migrations, and `wrangler deploy`.

Two things should land in the same pass, because the app has no access control
of its own yet:

- **Sign-in.** Cloudflare Access puts M365 SSO in front of the whole app with
  **no application code** — it is a dashboard setting, free for up to 50 users.
- **Reminder delivery.** Paste a Teams webhook into Settings, and add email
  credentials if you want email too.

`src/server/context.ts` has a single `actor()` function that every audit row
already flows through; wiring real identity into it is a one-function change.

## Layout

```
migrations/      schema (numbered, run in order)
seed/            demo data -- never run against a real deployment
src/shared/      types, validation, money, dates, alerts, metrics, CSV
src/server/      Hono API, repository layer, notification channels, cron
src/client/      React app
tests/           unit, API and end-to-end tests
```

All database access goes through `src/server/repo/`, behind a narrow `Db`
interface that a real D1 binding satisfies as-is. Nothing else writes SQL, so
moving this data to Postgres or in-house later means writing one adapter rather
than rewriting the app.
