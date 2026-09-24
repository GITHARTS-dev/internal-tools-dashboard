---
version: 2
slug: "src-client"
primary_target: "src/client"
related_targets: []
---

## Scope

The whole client: dashboard, tools, payments, history, our products, settings. Visitor mode: Operate, with one weekly Read visitor (the CEO) who sees the dashboard and nothing else.

## Direction contract

THESIS: The interface is a HARTS internal tool, and looks like one. The company's own dashboard (`TechUpdates/HARTS-Tech-Front-Dashboard.html`) is the brief: glass panels over a soft aurora made of the HARTS mark's four colours, Lexend / Source Sans 3 / JetBrains Mono, pill navigation with solid ink for the current place, tinted state triplets. The user pinned this aesthetic ("what our company would expect"), so brief-wins applies over generic taste warnings about glass and gradients.

SUPERSEDES: version 1, "The Statement" (ruled sections, no cards, system fonts). It was chosen before the company reference was seen and changed only the skin, not the layout or charts. Kept from it: tabular figures everywhere, method stated, colour never the only carrier of meaning.

OWN-WORLD: Aurora ground; glass panels (radius 12, blur 18, hairline white border, inset sheen); ink `#0f172a`; orange-red brand accent for focus and the selected-row marker; solid-ink primary buttons; mono uppercase tracked labels; eight-slot validated series palette used only in charts.

STORY: The admin opens it daily and sees what needs doing first. The CEO opens it monthly, reads one figure with its direction, sees the split, the trend and the concentration, and can find out how any number was made from a one-paragraph footer.

FIRST VIEWPORT: Glass top bar, page heading with as-at pill, urgent banner, then the headline figure with its own 12-month sparkline and the bought/own split.

FORM: Company house style. Do not introduce a second visual language.

## Constraints

HARTS wordmark supplied and binding (`public/harts-logo-on-*.png`). The purple in the company reference is a sub-brand (EVORA), not HARTS; not used. Fonts self-hosted; CSP allows `font-src 'self' data:`. Chart palette order is validated and may not be re-ordered without re-running the validator. Light is primary; dark is a selected set of steps.

## Unresolved

Whether the CEO needs a print or PDF export. The reference's data sits behind Microsoft sign-in, so only its stylesheet and structure were used, not its content.
