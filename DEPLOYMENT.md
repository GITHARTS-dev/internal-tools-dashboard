# Deployment runbook — Azure Static Web Apps + Supabase

Everything that can be built without live credentials is built and tested. This
file is what remains, in order, with the exact commands.

Nothing here has been run. No Azure resource, Supabase project, Teams workflow
or AWS key exists yet.

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
| `AAD_TENANT_ID` | Directory (tenant) ID |
| `AAD_CLIENT_ID` | Application (client) ID |
| `REMINDER_TOKEN` | A long random string you generate |
| `TEAMS_WEBHOOK_URL` | From step 5 (optional; can also live in Settings) |
| `AWS_ACCESS_KEY_ID` | From step 6 |
| `AWS_SECRET_ACCESS_KEY` | From step 6 |
| `APP_ENV` | `production` |

This is what the API uses to verify a request's token — the tenant and client
ID it should match, nothing more. There is no `AAD_CLIENT_SECRET` to set.

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
4. Inside the **Apply to each** over the request's `attachments`, use
   **Post card in a chat or channel** with:
   - Post as: **Flow bot**
   - Post in: **Chat with Flow bot**
   - Recipient: the first person's email
   - Adaptive Card: the loop item's `content`
5. Add a second **Post card in a chat or channel**, the same except for the
   recipient: the second person. A third person later is a third step.
6. Save, then copy the webhook URL from the trigger.

Labels shift a little between Teams versions; the shape is always trigger →
loop over attachments → one post-to-chat step per person.

That URL is a password -- anyone holding it can message those people. Put it in
the SWA environment variables as `TEAMS_WEBHOOK_URL`, or paste it into the app's
own Settings page.

Then press **Send test** beside Teams in Settings. Both people should get a chat
from the Workflows bot within a minute. The test records nothing, so it cannot
consume a real reminder's dedupe key.

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
the Entra rule in `staticwebapp.config.json` and checks `x-reminder-token` with
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

Unchanged by any of this, and still needs no cloud account:

```bash
npm install
npm run db:reset    # rebuild .data/dev.sqlite and load the demo data
npm run dev         # API on :8788, client on :5173
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
- [ ] Entra app registration, single-tenant, redirect platform is **Single-page application** (not Web — no secret should exist)
- [ ] "Expose an API" has an Application ID URI and the `access_as_user` scope
- [ ] (Optional) Assignment required = Yes, the specific people added, if sign-in should be limited to them
- [ ] Static Web App created on the **Free** plan, deployment token copied
- [ ] Azure-generated workflow deleted, this repo's kept
- [ ] SWA environment variables set (`DATABASE_URL` on the **pooler** 6543, `AAD_TENANT_ID`, `AAD_CLIENT_ID`)
- [ ] GitHub **secrets** set (`AZURE_STATIC_WEB_APPS_API_TOKEN`, `APP_URL`, `REMINDER_TOKEN`)
- [ ] GitHub **variables** set (`AAD_CLIENT_ID`, `AAD_TENANT_ID`) — the Variables tab, not Secrets
- [ ] Deploy green, `curl .../api/health` responds with no sign-in needed
- [ ] Redirect URI (the site's real hostname) added to the SPA platform in the app registration
- [ ] **Private window shows "Redirecting to sign in…" then Microsoft's login** — not the app's pages directly
- [ ] An account that shouldn't get in (outside the tenant, or not in the assigned list) is refused
- [ ] Settings → Exchange rates → **Fetch rates now** pressed once
- [ ] Teams workflow built, one post-to-chat step per person, trigger set to **Anyone**
- [ ] Webhook URL set, **Send test** reaches both people
- [ ] "Send due reminders" workflow run manually, card arrives
- [ ] AWS: Cost Explorer enabled, IAM user with only `ce:GetCostAndUsage`, keys set
- [ ] Settings → AWS costs: product chosen, **Import from AWS** records past months
- [ ] `reminders.yml` merged to `main`, so the daily schedule actually runs
