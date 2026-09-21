# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary: an admin / finance owner (one or two people) who maintains the ledger day to day, chases payments and acts on alerts. Secondary, mostly reading: tool owners (named per tool) and the CEO, who needs to know what the company spends on tools and on running its own internal products.

## Product Purpose
A ledger and reminder system for the SaaS tools the company pays for (Canva, M365, Clockify and the like), so nobody has to remember who owns what, when it renews, or what it costs. It answers: what do we pay for and who owns it; what did we actually pay (a payment history that outlives the subscription); and what is about to bite us (alerts before renewals, payments due, and the last day to cancel).

Planned scope extension: also track the running cost of the company's own internal products (hosting, domains, APIs) so the CEO can see it alongside bought subscriptions, with a CEO-facing cost summary.

## Positioning
Not a generic spend dashboard: it is built around the moments that cost money by surprise (the cancellation-notice deadline, idle paid seats, unowned records) and keeps an immutable history, so "what did X cost us last year" is always answerable.

## Operating Context
Runs locally today; nothing is deployed yet. The deployment target is decided: Azure Static Web Apps (Free plan) with its managed Azure Functions for the API, Supabase Postgres for data, and Static Web Apps' built-in Entra sign-in. This was chosen to match the environment the company's other internal tools already use (the timesheet tracker runs on the same Supabase + SWA + managed Functions stack), so there is one deploy story and one set of credentials across them. The daily reminder check runs from a scheduled GitHub Actions workflow, because SWA's managed Functions are HTTP-only and have no timer trigger. Reminders go to a Teams webhook and/or email. Data can be loaded by CSV import with a preview step. Two currencies are in use (INR and USD).

## Capabilities and Constraints
- Tools, payments ledger, audit history, alert engine (single source of truth for "needs attention"), dashboard KPIs and charts, CSV import/export, reminder dry-run preview.
- Money is stored as integers in minor units with an explicit currency, and is shown in its original currency by default.
- Where a single common currency is required (combined totals, the CEO summary), amounts are converted at the ECB reference rate of the month each amount belongs to: run-rate figures at the latest published month, historical payments at the month they were paid. Conversions are always labelled, and anything with no usable rate is excluded from the total and reported on screen rather than guessed at. The per-category chart deliberately stays per-currency.
- Internal products are modelled as buckets that ordinary tools are attributed to, so their running cost is a roll-up of the existing ledger rather than a second one. Cost covers subscription and licence cash only; people and staff-time cost is explicitly excluded and has nowhere to be recorded.
- Nothing is deleted; cancelled tools are archived with history.
- No sign-in in the app itself yet.
- Undecided: whether invoices are stored or only amounts.

## Brand Commitments
Must follow HARTS branding. The user supplies the brand material; do not invent any beyond it. The official logo is in `public/`: `harts-logo-on-light.png` (black wordmark) and `harts-logo-on-dark.png` (white wordmark); the mark is a four-colour (red-orange, green, amber, blue) ring of figures around a yellow star. No brand guide (colours, typefaces, voice) has been supplied yet. The user also explicitly does not want it to look like a standard AI-made dashboard.

## Evidence on Hand
Demo seed data (seed/dev-seed.sql) is deliberately messy and fictional, not real company data. The only HARTS brand assets in the repository are the two logo files above; no brand guide exists yet, so palette and type must not be presented as official HARTS values. The accent tokens in `src/client/styles.css` are sampled from the logo and labelled as such.

Reminder delivery is coded and unproven: no Teams channel or webhook URL exists yet, and no deployment has happened. `DEPLOYMENT.md` holds the runbook.

## Product Principles
1. Surface what needs action before what is merely interesting.
2. One definition of "needs attention", shared by screen and reminders.
3. History is never lost; the ledger outlives the subscription.
4. Money is exact and shown in its original currency; it is converted only where a common currency is needed, at the payment month's rate, and always labelled as converted.
5. Serve the admin's daily work first; make the CEO's view a clear read-only summary of the same data.
