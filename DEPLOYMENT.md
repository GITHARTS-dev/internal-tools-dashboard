# Deployment runbook — Azure Static Web Apps + Supabase

The steps to take this app live, in order, with the exact commands.

**Status (28 Sep 2026):** steps 1–5 are done. The app is live on Azure Static
Web Apps against a Supabase database, sign-in works, and Teams reminders reach
their recipients. AWS cost import (step 6) and email (step 7) are not set up.
If something misbehaves, [Troubleshooting](#troubleshooting) lists every
problem hit on the way there and its fix.

```
GitHub push
  └─ GitHub Actions
      ├─ Vite client  →  Azure Static Web Apps        (free)
      └─ Hono API     →  SWA managed Functions        (free, included)
                              └─ Supabase Postgres    (free)

Sign-in:   MSAL in the browser (PKCE, no client secret) + the API verifies
           the resulting token itself — free, no domain required
Reminders: a scheduled GitHub Actions workflow calls POST /api/reminders/run
```

---

## What you actually have to create

| Thing | How | Cost |
|---|---|---|
| Supabase project | supabase.com → New project | Free tier |
| Azure Static Web App | Portal → Create → Static Web App → **Free** plan | Free |
| Entra app registration | Portal → Entra ID → App registrations | Free |
| Teams workflow | Teams → Workflows (sends each recipient a personal chat) | Free |
| AWS IAM user | AWS console, in the account the bill comes from | ~USD 0.01 a month |

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

In PowerShell:

```powershell
$env:DATABASE_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
npm run migrate:pg
```

A password containing `@`, `#`, `/` or `?` must be URL-encoded inside the URI.
If the direct host cannot be reached (it is IPv6-only on some plans, and many
office networks are not), use the **session pooler** URI from the same page.

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

This is what restricts sign-in to your company, and it is what the app
actually signs into: there is no client secret anywhere in this setup. The
browser runs the sign-in itself (MSAL, Authorization Code + PKCE) and the API
checks the resulting token's signature, tenant and audience on every request
(`src/server/auth/`). Nothing sits in front of it doing that for you.

Portal → **Microsoft Entra ID → App registrations → New registration**:

- Name: `Tools dashboard`
- Supported account types: **Accounts in this organizational directory only**
- Redirect URI: leave blank for now — added below once the platform type is
  set correctly, and again once you know the site's hostname.

After it's created:

1. **Authentication → Add a platform → Single-page application.** This is the
   step that matters: it is what tells Entra to allow the PKCE flow without a
   secret. Do **not** pick "Web" — that platform type expects a client secret
   and PKCE-only sign-in will be refused.
   - Redirect URI: `https://<your-site>.azurestaticapps.net/` (root path, not
     a callback path — MSAL handles the response on whatever page it left
     from). You will not know the hostname until the first deploy; come back
     and add it once you do. For now, also add `http://localhost:5173/` here,
     so local development can sign in the same way.
2. **Expose an API → Add**. Accept the default **Application ID URI**
   (`api://<client-id>`) → **Save**.
3. Still on **Expose an API → Add a scope**:
   - Scope name: `access_as_user`
   - Who can consent: **Admins and users**
   - Give it any admin/user consent display name and description — e.g. "Use
     the tools dashboard API" / "Lets the app read and update your company's
     tools, payments and product costs on your behalf."
4. Note the **Application (client) ID** and the **Directory (tenant) ID** from
   the Overview page. Neither is secret — they identify the app, the same way
   a URL does, and both end up baked into the built JavaScript regardless.
   There is no client secret to create.

### Restricting sign-in to specific people

Single-tenant sign-in (above) lets anyone with a company account in. If only a
handful of named people should actually use this:

1. **Entra ID → Enterprise applications** → find "Tools dashboard".
2. **Properties → Assignment required?** → **Yes**.
3. **Users and groups → Add user/group** → add each person by name.

Now only those people can sign in — everyone else is refused at Microsoft's
own login screen, the same as someone outside the company entirely.

---

## 3. The Static Web App

Portal → **Create a resource → Static Web App**:

- Plan type: **Free**
- Deployment source: **Other**. This repo's own workflow,
  [.github/workflows/azure-deploy.yml](.github/workflows/azure-deploy.yml),
  runs the tests, builds the app and API, and uploads the result. Picking
  **GitHub** here instead makes Azure commit a second workflow of its own that
  skips the tests and knows nothing about the sign-in build variables; if that
  happens, delete it and keep this one.

Copy the **deployment token** (Overview → Manage deployment token), and the
site's address from the Overview page.

`staticwebapp.config.json` lives in `public/`, not the repo root: the deploy
only reads it from the built output (`dist/client`), and Vite copies `public/`
there. At the root, the API runtime setting in it was never seen and the
deploy failed with "Function language info isn't provided."

### Configuration

**Settings → Environment variables**, for the Production environment:

| Name | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** URI, port **6543** |
| `AAD_TENANT_ID` | Directory (tenant) ID |
| `AAD_CLIENT_ID` | Application (client) ID |
| `REMINDER_TOKEN` | A long random string you generate |
| `APP_ENV` | `production` |
| `APP_URL` | `https://<your-site>.azurestaticapps.net` (optional: adds "Open the dashboard" and per-alert links to Teams cards) |
| `TEAMS_WEBHOOK_URL` | From step 5 (optional; can also live in Settings) |
| `AWS_ACCESS_KEY_ID` | From step 6 |
| `AWS_SECRET_ACCESS_KEY` | From step 6 |

`AAD_TENANT_ID` and `AAD_CLIENT_ID` are what the API verifies a request's token
against — the tenant and client ID it should match, nothing more. There is no
`AAD_CLIENT_SECRET` to set.

**Set all of these before the first deploy**, not after. Each one that guards
something is inert while unset, by design, so local development needs no setup:

- Without `AAD_TENANT_ID` / `AAD_CLIENT_ID`, the API checks no tokens at all.
  The site still shows Microsoft's login, but anyone calling the API directly
  can read and change everything.
- Without `REMINDER_TOKEN`, `POST /api/reminders/run` is open to anyone, and
  its response lists the current alerts: tool names, owners and their emails.

`APP_URL` is also a GitHub secret below, but that one only tells the reminder
workflow where to call; the API cannot see GitHub secrets, so the card links
need it here too. Azure applies a changed variable without a redeploy.

Generate the reminder token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`APP_ENV=production` is not decorative: it disables the endpoints that wipe or
reload demo data.

### GitHub repository secrets and variables

**Repo → Settings → Secrets and variables → Actions**, split across two tabs:

**Secrets** tab:

| Secret | Value |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | The deployment token |
| `APP_URL` | `https://<your-site>.azurestaticapps.net` |
| `REMINDER_TOKEN` | The same string as above |

**Variables** tab (not secret — these get baked into the built JavaScript, so
there would be no point hiding them):

| Variable | Value |
|---|---|
| `AAD_CLIENT_ID` | Application (client) ID, same value as above |
| `AAD_TENANT_ID` | Directory (tenant) ID, same value as above |

Why the two IDs are set in both places: the browser part of the app is plain
files built by GitHub, so it can only know where to sign in if the IDs are
written into it at build time (GitHub Variables). The API runs on Azure and
reads its settings there on every request (Azure environment variables) to
check that each token came from that same sign-in. `DATABASE_URL` is only ever
in Azure, so the database password never ends up in files a browser downloads;
the deployment token is only ever in GitHub.

---

## 4. Deploy

Until `AZURE_STATIC_WEB_APPS_API_TOKEN` exists as a repo secret, the workflow
still runs tests and the build on every push -- that is real CI worth having
early -- but the Deploy step itself is skipped rather than failing. Adding the
secret (step 3, "Configuration" above the checklist) is the only change needed
to turn deployment on; the workflow file does not need touching again.

Push to the deployment branch, or run the workflow by hand from the Actions tab.
It runs `npm test` first, so a broken build does not reach production.

Then check it:

```bash
curl https://<your-site>.azurestaticapps.net/api/health
```

This one works with a plain `curl` and no sign-in — it is one of the two routes
`requireAuth()` deliberately leaves open (`src/server/auth/middleware.ts`), so
it is a check of the deploy itself, not of sign-in. It should show `"ok": true`.

Two things are worth verifying deliberately, in the browser:

1. **Open the site in a private window.** You should briefly see "Redirecting
   to sign in…" and then land on a Microsoft sign-in page. If the app's pages
   render instead, sign-in is not wired up — check `VITE_AAD_CLIENT_ID` /
   `VITE_AAD_TENANT_ID` were actually set when the build ran (a GitHub Actions
   repo **variable**, not secret — easy to add to the wrong tab).
2. **Try an account that shouldn't get in** — outside your tenant, or one of
   your own not in the assigned-users list if you set that up in step 2. It
   should be refused at Microsoft's own screen. If it gets through, check the
   app registration's account type, or the assignment-required setting.

Seed the exchange rates once, signed in as yourself: **Settings → Exchange rates
→ Fetch rates now**. They are refreshed daily after that.

(You cannot `curl` this one, or most other routes — they all require a valid
access token now, which only the signed-in browser has. The reminder token
only opens `/api/reminders/run`. That route also fetches a 24-month backfill on
its first run when no rates are stored, so running the reminder workflow once
does the same job.)

---

## 5. Teams reminders, as personal chats

Reminders go to named people as a private Teams chat, not into a channel. The
app posts one card to a webhook; a Teams workflow receives it and sends it on to
each person. No app registration, no admin consent, and no code change to add
or remove someone -- the list of recipients lives in the workflow.

Build it once, signed in as either recipient:

1. In Teams, open **Workflows** (in the left rail, or `⋯` → Workflows).
2. Start from **"Send webhook alerts to a chat"**, or create a blank flow whose
   trigger is **"When a Teams webhook request is received"**.
3. In the trigger, set **Who can trigger the flow** to **Anyone**. The app has no
   Microsoft identity to sign the request with; the URL itself is the secret.
4. Add **Apply to each**, and for its input use the expression (the **fx**
   button, not typed into the box):
   ```
   triggerBody()?['attachments']
   ```
5. Inside the loop, add **Post card in a chat or channel** with:
   - Post as: **Flow bot**
   - Post in: **Chat with Flow bot**
   - Recipient: the first person's email
   - Adaptive Card: this expression, again entered through **fx** so the field
     shows a coloured pill rather than plain text:
     ```
     string(items('Apply_to_each')?['content'])
     ```
     Picking the loop item's "content" from the dynamic-content list instead
     can hand Teams the card as an object rather than as text, and the run
     fails with "The specified Teams flowbot message's message body is invalid
     JSON". The `string(...)` is what prevents that. If the loop is named
     differently, use its name with spaces as underscores.
6. Add another **Post card in a chat or channel**, still inside the loop, the
   same except for the recipient. One step per person.
7. Save, then copy the **HTTP POST URL** from the trigger. It only appears
   after the first save.

Labels shift a little between Teams versions; the shape is always trigger →
loop over attachments → one post-to-chat step per person.

The **"Send webhook alerts to a chat"** template is the simpler alternative: it
posts everything into one chat you pick, with no loop to build. Pick a group
chat containing everyone who should be told, and changing recipients later is
a change of chat in the workflow. Only one workflow's URL can be in Settings at
a time, so delete whichever one is not in use.

That URL is a password -- anyone holding it can message those people. Put it in
the SWA environment variables as `TEAMS_WEBHOOK_URL`, or paste it into the app's
own Settings page.

Then press **Send test** on the Teams row of **Settings → Where reminders go**.
The button stays disabled until the URL has been saved. Every recipient should
get a chat from the Workflows bot within a minute: a card saying reminders are
reaching them, with an example reminder labelled as one. The test records
nothing, so it cannot consume a real reminder's dedupe key. It is the only way
to send without consuming one: the daily run and a manual run of **Send due
reminders** both send every due alert for real, once, to whoever is in the
workflow at the time. Test with stand-in recipients using **Send test** only,
and switch to the real people before the daily run is enabled.

To pause all reminders, disable **Send due reminders** (Actions → the workflow
→ ⋯ → Disable workflow); turning the Teams flow off as well stops anything
else reaching it. A send that fails is not recorded, so nothing is lost by
pausing.

One thing to know: the workflow accepts the card and then delivers it on its
own, so the app sees "accepted", not "delivered". If a card does not arrive,
look at the flow's **run history** in Workflows -- that is where a wrong
recipient or an expired connection shows up.

### What actually gets sent, and when

The scheduled workflow runs once a day. **That is the check, not the message.**
It asks "is anything crossing a reminder threshold today?" and posts only when
the answer is yes:

- A renewal is 60 / 30 / 14 / 7 / 3 / 1 days away (configurable in Settings).
- A payment is due soon, or is overdue.
- The last day to cancel without paying for another period is approaching.
- A tool is missing data, or has seats nobody uses.
- A product's costs for last month are still missing from the 5th (once AWS
  import is set up, the AWS line fills itself before this is checked).

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
the API's sign-in check (`requireAuth()` in `src/server/auth/middleware.ts`)
and checks `x-reminder-token` with
a constant-time comparison. Without `REMINDER_TOKEN` set, the guard is inert —
fine locally, wrong in production. **Set it.**

---

## 6. AWS costs, imported instead of typed

With this in place nobody enters the AWS bill each month: the daily run reads
last month's total from AWS Cost Explorer once AWS marks it final (usually the
first few days of the month) and records it on the product. It is the same
total as the invoice that arrives at the shared mailbox -- usage, tax and
credits together -- but read from AWS directly, so no mailbox access is needed.

Do this in the AWS account the bill comes from. If you use AWS Organizations,
that is the management (payer) account.

1. **Billing and Cost Management → Cost Explorer**: open it once if nobody ever
   has. The first launch can take up to a day to fill with data.
2. **IAM → Users → Create user**, e.g. `tools-dashboard-costs`, with no console
   access. Attach an inline policy that allows one read-only call and nothing
   else:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ce:GetCostAndUsage", "Resource": "*" }
     ]
   }
   ```

3. **Security credentials → Create access key** (use case: application running
   outside AWS). Put the pair in the SWA environment variables as
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
4. In the app: **Settings → AWS costs**, choose the product the bill belongs to,
   **Save**, then **Import from AWS** to bring in the past twelve months.

Each request costs USD 0.01. The daily run makes one request a month, plus one
a day for the few days AWS still calls the month "estimated".

If the import says access is denied although the policy is right, the account
may have IAM access to billing data switched off: **Account → IAM user and role
access to Billing information → Activate**.

### When a second product arrives

Every product runs in the same AWS account, so the bill has to be split, and the
split is a **cost-allocation tag**:

1. Tag each product's AWS resources with the product's name as it appears in
   the app, e.g. `Product = TRA`, `Product = Timesheet`.
2. **Billing → Cost allocation tags**: find `Product` and **Activate** it. AWS
   only splits costs by a tag from the day it is activated, and it takes up to a
   day to appear -- so activate it as soon as tagging starts.
3. **Settings → AWS costs → Split by cost-allocation tag**: enter `Product`.

Tagged spend then goes to the product with that name, matched ignoring case.
Untagged spend -- and anything tagged with a name no product has -- goes to the
product chosen above, and that line's note says so. Shared things such as a
support plan or tax are never tagged, so they always land on that product.

A figure someone typed or corrected on a product page is never overwritten by
an import; the import reports it instead. Delete the typed line and import
again to use AWS's figure.

## 7. Email (optional, still inert)

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

Still needs no cloud account. Node 22.9 or newer:

```bash
npm install         # again after every pull that changes package.json
npm run db:reset    # rebuild .data/dev.sqlite and load the demo data
npm run dev         # API on :8788, client on :5173
```

Local runs on SQLite so it stays instant and offline. The fidelity that costs is
bought back in `tests/postgres.test.ts`, which runs the whole API against real
Postgres — PGlite, Postgres compiled to WASM — on every `npm test`. That is what
catches dialect differences before they reach Supabase.

Optional settings go in a `.env.local` file in the project root. It is
git-ignored, so each developer makes their own (on Windows, check it has not
been saved as `.env.local.txt`):

```
# Sign in locally exactly as on the live site. Leave out to skip sign-in.
VITE_AAD_CLIENT_ID=<Application (client) ID>
VITE_AAD_TENANT_ID=<Directory (tenant) ID>

# Use Postgres instead of SQLite. Leave out to stay on SQLite.
DATABASE_URL=postgresql://...
```

Vite reads the `VITE_*` lines for the browser; `npm run dev:api` loads the same
file into the API process, so `DATABASE_URL` there takes effect. Restart
`npm run dev` after changing it. The API prints which database it is using when
it starts: `SQLite · .data/dev.sqlite` or `Postgres · DATABASE_URL`.
`npm run db:reset` only ever touches the SQLite file.

**Point local development at a separate Supabase project, never the live one.**
Locally `APP_ENV` is unset, so **Settings → Sample data → Delete everything**
is enabled, and the Teams webhook URL is stored in the database. Against the
live database, one click on a developer's machine deletes every real record,
and **Send test** there messages the real recipients.

---

## Rollback

Static Web Apps keeps previous deployments; the reliable rollback is to revert
the commit and let the workflow redeploy.

The database is separate. Supabase free tier has daily backups with limited
retention — check what yours actually has **before** you need it. Nothing in
this app hard-deletes: cancelled tools are archived and keep their payment
history, so the common "undo" is a status change, not a restore.

---

## Troubleshooting

Every one of these happened during the first deploy. The code fixes are in; the
entries are here for when the symptom comes back from a configuration change.

| Symptom | Cause | Fix |
|---|---|---|
| Every push to `main` fails within a second, with no jobs, and emails you | The workflow file is invalid. GitHub rejects `secrets.*` inside an `if:` | Test secrets through `env` in `if:` conditions, as `azure-deploy.yml` now does |
| Deploy workflow fails at **Test** | Node older than 22; vitest 5 needs 22+ | `node-version: 22` in the workflow (already set) |
| Deploy fails with "Function language info isn't provided" | `staticwebapp.config.json` not in the built output | It must live in `public/` (already moved) |
| Signing in bounces back and forth forever, then signs out | The app redirected to sign-in before MSAL had finished starting up | Fixed in `AuthGate.tsx`: it waits for `inProgress === None` |
| Signed in, but every page says "Your sign-in has expired" | Static Web Apps overwrites the `Authorization` header before the API sees it | The browser sends the token as `x-access-token` instead (already done). If it recurs, check `AAD_TENANT_ID` / `AAD_CLIENT_ID` in Azure for typos or trailing spaces, then paste the `x-access-token` from the browser's Network tab into <https://jwt.ms> and compare its `aud`, `iss` and `tid` |
| "Sign-in didn't complete: state_mismatch" | A stale sign-in attempt in that tab, typically from before the redirect URI existed, or storage cleared mid-attempt | Close every tab of the site and open it in a fresh private window |
| `curl <site>/api/dashboard` with no token says "sign-in has expired", not "Sign in required" | Expected: Static Web Apps put its own value in `Authorization`, which is refused | Nothing to fix; it confirms the token check is on |
| Teams run history: "message body is invalid JSON" | The Adaptive Card field received the card as an object, or the expression as plain text | Use `string(items('Apply_to_each')?['content'])`, entered through **fx** (step 5) |
| A developer's local `npm run dev` stays on SQLite despite `DATABASE_URL` in `.env.local` | Their copy predates `.env.local` loading, or the file is `.env.local.txt` | `git pull`, check the file name, restart |
| `'concurrently' is not recognized` | `npm install` not run after cloning | `npm install` |
| Sample-data buttons are disabled on the live site | `APP_ENV=production`, deliberately | Point a local copy at the live database briefly, use **Remove demo data** (never **Delete everything**), then point it back |

---

## Checklist

- [x] Supabase project created, password saved
- [x] `npm run migrate:pg` against the **direct** URI (5432) succeeds
- [x] Entra app registration, single-tenant, redirect platform is **Single-page application** (not Web — no secret should exist)
- [x] "Expose an API" has an Application ID URI and the `access_as_user` scope
- [ ] (Optional) Assignment required = Yes, the specific people added, if sign-in should be limited to them
- [x] Static Web App created on the **Free** plan, deployment source **Other**, deployment token copied
- [x] SWA environment variables set (`DATABASE_URL` on the **pooler** 6543, `AAD_TENANT_ID`, `AAD_CLIENT_ID`, `REMINDER_TOKEN`, `APP_ENV`, `APP_URL`)
- [x] GitHub **secrets** set (`AZURE_STATIC_WEB_APPS_API_TOKEN`, `APP_URL`, `REMINDER_TOKEN`)
- [x] GitHub **variables** set (`AAD_CLIENT_ID`, `AAD_TENANT_ID`) — the Variables tab, not Secrets
- [x] Deploy green, `curl .../api/health` responds with no sign-in needed
- [x] `curl -X POST .../api/reminders/run` with no token returns **401**
- [x] Redirect URI (the site's real hostname) added to the SPA platform in the app registration
- [x] **Private window shows "Redirecting to sign in…" then Microsoft's login** — not the app's pages directly
- [ ] An account that shouldn't get in (outside the tenant, or not in the assigned list) is refused
- [ ] Settings → Exchange rates → **Fetch rates now** pressed once
- [x] Teams workflow built, one post-to-chat step per person, trigger set to **Anyone**
- [x] Webhook URL set, **Send test** reaches both people
- [ ] Real recipients in the Teams workflow, test tool and demo data removed
- [ ] "Send due reminders" workflow run manually, card arrives
- [ ] Local development pointed at a separate Supabase project, not the live one
- [ ] AWS: Cost Explorer enabled, IAM user with only `ce:GetCostAndUsage`, keys set
- [ ] Settings → AWS costs: product chosen, **Import from AWS** records past months
- [x] `reminders.yml` merged to `main`, so the daily schedule actually runs
