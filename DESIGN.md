# Design

This app looks like the rest of HARTS. Its visual language is taken from the company's own dashboard (`TechUpdates/HARTS-Tech-Front-Dashboard.html`, kept locally in the git-ignored `HARTS-internal-tools-dashboard/` folder as a reference and never shipped). An internal tool that looks like a stranger to the rest of the estate is a small tax on everyone who uses both.

**History.** An earlier round, "The Statement" (ruled sections, no cards, system fonts), was chosen before that reference was known. It was only a skin over the same layout, and it was not what the company would expect. It is superseded. What survives from it: figures are tabular-lined, method is stated, and colour never carries meaning alone.

## The house style (borrowed, deliberately)

- **Glass over an aurora.** Panels are translucent white (`--glass`, `backdrop-filter: blur(18px) saturate(170%)`, hairline white border, inset sheen, soft lift, 12px radius). Behind them is a fixed ground of four blurred orbs, drifting slowly (light uses a cool teal, sky and mint set so this app is not a twin of the other HARTS dashboards; dark keeps the four colours of the HARTS mark) and holding still under `prefers-reduced-motion`. Without the ground, glass is just a pale rectangle.
- **Type.** Lexend for headings and controls, Source Sans 3 for reading, JetBrains Mono for tracked uppercase labels, dates and figures' small print. All three are self-hosted (`@fontsource-variable/*`), so the CSP stays `default-src 'self'` with `font-src 'self' data:`.
- **Navigation.** A glass top bar: logo, pill tabs (solid ink for the current one), urgent count, theme toggle. The page's own heading sits under the bar on the aurora, with an "as at" pill.
- **State colour.** One triplet per state — tint, hairline, saturated text — always with an icon or a word. Orange-red is the brand accent and the focus/hover marker; blue is links; green is good; amber is soon; red is overdue.
- **Ink.** `#0f172a` headings, `#334155` body, `#566274` muted (4.5:1 on the glass composite). Primary buttons are solid ink, not brand-coloured.

## What is ours

- **Chart series never leak into chrome.** Eight categorical slots in a validated order (`--series-1..8`; light and dark sets). The order is the colourblind-safety mechanism and may not be rearranged without re-running the validator. Slots 3, 4 and 5 are below 3:1 on light, so anything wearing them carries a visible label. All-pairs forms cap at three slots. The purple of the reference belongs to a sub-brand (EVORA), not HARTS, and is not used.
- **Charts** are hand-rolled SVG, measured to real pixel width: stacked columns (subscriptions vs cloud usage, last 12 complete months), a running-total year-on-year line (this year is the accent, last year neutral grey, the gap labelled), a renewal timeline that draws each tool's last day to cancel and the already-committed stretch after it, and ranked bars with share of the whole (one number format per column). The headline has no sparkline: it showed the same monthly totals as the stacked columns. A month-by-month table was tried in place of the columns and judged worse; the columns stay. Every chart has a hover layer and an `aria-label` listing its values.
- **Chart layout rules.** Nothing is drawn where it can collide: axis labels sit in a gutter left of the plot, never on a mark; names get a column (the renewal timeline) or a whole line above their bar (ranked bars), never squeezed beside it and cut short. The axis ceiling is the smallest round number above the data (steps 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10), so the tallest mark reaches most of the way up. Series are named once, in the legend. Small figures set side by side all use `formatShort` ('₹54K', '₹4.6L'), never a mix of compact and full.
- **Money.** Integer minor units, each amount in its own currency; combined figures are converted at the ECB rate of the month they belong to. Unknown is never shown as zero ("Not known yet"). Amounts left out for want of a rate are announced under the headline (`CoverageNotice`), not buried.
- **How figures are made** is a short footer (`MethodFooter`) on the dashboard, with the paid-by-year table one click away.
- **Change log** lives in Settings. It is an audit trail, not something to read on arrival.

## Layout of the dashboard

Headline figure — what was actually paid this year so far — with two small figures under it (subscriptions, cloud) -- a "last 12 months" figure beside it was removed, as two near-identical totals over overlapping periods read as a discrepancy -- beside what the calendar year is committed to by 31 December (paid + overdue + subscription bills still to come on their real dates), split in a four-column table: Subscriptions / Our products × Paid / To come / Total. No sentences in the headline: figures, labels and one footnote. Cloud usage still to be billed is never predicted -- it moves with use -- and joins the total as each month's bill is entered; coverage notice if any; Needs attention beside Renewals and idle seats (by tool); spend by month beside our products; biggest subscriptions beside categories; method footer. Cards sit in pairs of the same shape so they share top and bottom edges. The twelve-month run rate is no longer a headline -- it read as money already spent -- and lives one click into the forecast, for comparing tools.

## Prohibitions

No side-stripe borders (a 2px coloured left edge). The selected-row marker is an inset shadow, as in the company reference, and the banner uses a top hairline. No gradient text. No decorative charts (no heatmap because a reference had one). No hero-metric template beyond the single headline. No purple.

## Dark

A selected set of steps for a dark ground, not an inversion: glass becomes a faint white wash, the aurora drops to ~60%, tints become translucent, text-safe hues brighten.

## Accessibility

Text steps were chosen to clear 4.5:1 on white and on the tinted glass; this has not been measured in a browser with a tool. Focus ring 2.5px brand orange. Every status has an icon or word. Navigation scrolls horizontally on phones rather than wrapping into a wall. `prefers-reduced-motion` stops the aurora and the load-in.

**Drill-downs.** Every money figure opens a side panel (`components/drilldown.tsx`) showing what it is made of. Every panel has one shape, so it is read at a glance: a title, one line naming the period, a ruled row of figures (the total first and larger), then tables — no paragraphs and no label above the title. Amounts are in the reporting currency with the original underneath only when it differs; the by-currency table appears only when more than one currency is involved. The panels show for paid money, every payment and cloud bill as paid and in the reporting currency, with a by-currency table; for the committed year, paid so far plus each overdue bill and each subscription bill still to come; for the run rate, every subscription at its price and each product's usage average with the months behind it. Its lines add up to the figure it was opened from, and that is tested. The open panel lives in the URL (`?view=month:2026-09`), so Back closes it.

A tool in the Trash counts for nothing anywhere -- not its payments, paid or owed. Restoring it brings them back.

**Tools list.** Grouped by category in the table itself — one `tbody` per category, headed by its name, tool count and yearly cost per currency — rather than filtered by a dropdown, so the whole estate is visible at once. Sorting applies within each group.
