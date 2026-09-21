# Design

This app looks like the rest of HARTS. Its visual language is taken from the company's own dashboard (`TechUpdates/HARTS-Tech-Front-Dashboard.html`, kept locally in the git-ignored `HARTS-internal-tools-dashboard/` folder as a reference and never shipped). An internal tool that looks like a stranger to the rest of the estate is a small tax on everyone who uses both.

**History.** An earlier round, "The Statement" (ruled sections, no cards, system fonts), was chosen before that reference was known. It was only a skin over the same layout, and it was not what the company would expect. It is superseded. What survives from it: figures are tabular-lined, method is stated, and colour never carries meaning alone.

## The house style (borrowed, deliberately)

- **Glass over an aurora.** Panels are translucent white (`--glass`, `backdrop-filter: blur(18px) saturate(170%)`, hairline white border, inset sheen, soft lift, 12px radius). Behind them is a fixed ground of four blurred orbs in the four colours of the HARTS mark, drifting slowly and holding still under `prefers-reduced-motion`. Without the ground, glass is just a pale rectangle.
- **Type.** Lexend for headings and controls, Source Sans 3 for reading, JetBrains Mono for tracked uppercase labels, dates and figures' small print. All three are self-hosted (`@fontsource-variable/*`), so the CSP stays `default-src 'self'` with `font-src 'self' data:`.
- **Navigation.** A glass top bar: logo, pill tabs (solid ink for the current one), urgent count, theme toggle. The page's own heading sits under the bar on the aurora, with an "as at" pill.
- **State colour.** One triplet per state — tint, hairline, saturated text — always with an icon or a word. Orange-red is the brand accent and the focus/hover marker; blue is links; green is good; amber is soon; red is overdue.
- **Ink.** `#0f172a` headings, `#334155` body, `#566274` muted (4.5:1 on the glass composite). Primary buttons are solid ink, not brand-coloured.

## What is ours

- **Chart series never leak into chrome.** Eight categorical slots in a validated order (`--series-1..8`; light and dark sets). The order is the colourblind-safety mechanism and may not be rearranged without re-running the validator. Slots 3, 4 and 5 are below 3:1 on light, so anything wearing them carries a visible label. All-pairs forms cap at three slots. The purple of the reference belongs to a sub-brand (EVORA), not HARTS, and is not used.
- **Charts** are hand-rolled SVG, measured to real pixel width: stacked columns (subscriptions vs cloud usage, last 12 complete months), a running-total year-on-year line (this year is the accent, last year neutral grey, the gap labelled), a renewal timeline that draws each tool's last day to cancel and the already-committed stretch after it, ranked bars with share of the whole (one number format per column), and a sparkline in the headline. Every chart has a hover layer and an `aria-label` listing its values.
- **Money.** Integer minor units, each amount in its own currency; combined figures are converted at the ECB rate of the month they belong to. Unknown is never shown as zero ("Not known yet"). Amounts left out for want of a rate are announced under the headline (`CoverageNotice`), not buried.
- **How figures are made** is a short footer (`MethodFooter`) on the dashboard, with the paid-by-year table one click away.
- **Change log** lives in Settings. It is an audit trail, not something to read on arrival.

## Layout of the dashboard

Headline figure with its own sparkline and the bought/own split; coverage notice if any; Needs attention beside Renewals and idle seats (by tool); spend by month beside this year against last; biggest subscriptions, categories, products; method footer.

## Prohibitions

No side-stripe borders (a 2px coloured left edge). The selected-row marker is an inset shadow, as in the company reference, and the banner uses a top hairline. No gradient text. No decorative charts (no heatmap because a reference had one). No hero-metric template beyond the single headline. No purple.

## Dark

A selected set of steps for a dark ground, not an inversion: glass becomes a faint white wash, the aurora drops to ~60%, tints become translucent, text-safe hues brighten.

## Accessibility

Text steps were chosen to clear 4.5:1 on white and on the tinted glass; this has not been measured in a browser with a tool. Focus ring 2.5px brand orange. Every status has an icon or word. Navigation scrolls horizontally on phones rather than wrapping into a wall. `prefers-reduced-motion` stops the aurora and the load-in.
