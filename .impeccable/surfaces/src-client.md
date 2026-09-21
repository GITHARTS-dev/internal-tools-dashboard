---
version: 1
slug: "src-client"
primary_target: "src/client"
related_targets: []
---

## Scope

The whole client: dashboard, tools, payments, history, our products, settings. Visitor mode: Operate, with one weekly Read visitor (the CEO) who sees the dashboard and nothing else.

## Direction contract

THESIS: This is a financial statement, not a control panel. It owns the reading conventions of the printed accounts a CEO already trusts — ruled sections, columns that foot to a total, figures that align down the page, and footnotes that carry the method. It refuses the category default it currently is: a grid of same-size white cards with soft borders, rounded corners, a KPI row, and a blue accent, where every section shouts at the same volume and nothing is subordinate to anything.

OWN-WORLD: Cool paper white (#fbfbfc) and true white sheets, near-black cool ink (#0a0c10), hairline rules at 1px doing every job a border and a shadow used to do. No card, no radius over 4px, no shadow as separation. One accent, deep ink blue, used only for what is interactive; the validated eight-slot series palette is reserved for charts and never leaks into chrome; red is reserved for money at risk. Section labels are 11px tracked uppercase above a rule. Every figure is tabular-lined. Money columns right-align and total under a rule. Superscript markers on any derived figure, resolving to real footnotes at the foot of the sheet.

STORY: The admin opens it daily and sees what needs doing before anything else. The CEO opens it monthly, reads one figure, sees how it splits and which way it is moving, and can find out how any number was made without asking anyone. Both leave able to quote a figure and defend it.

FIRST VIEWPORT: A statement header — sheet name left, "AS AT 21 SEP 2026" right, hairline rule under, full bleed to the content column. Then the lead block: "COMMITTED SPEND" as a tracked label, the annual figure at 56px with real void around it, and beneath it the monthly rate and the paid-last-12-months line with its direction. A rule. Then the split as a two-row foot-to-total table, right-aligned, ruled above the total. A rule. Then "NEEDS ATTENTION" with the alert rows hung off a left datum. The primary action is reading; the only controls in the first viewport are the alert rows themselves, which open their record.

FORM: The Statement — the printed annual report and financial-statement tradition. Candidate 8 on the ordered list, added after the user's constraint ("executive level dashboard I can show to my CEO") knocked out the assigned Drawing Sheet on task grounds: a redline-markup working drawing is the wrong register for a document shown to a CEO, which is a named task failure rather than taste. Seed key 0d3cdce1 (direction/operate). Raised by the dealt hand: one datum ruling every row and a hard mono/prose split for figures (Depth Profile, competitive); real void around the lead figure (Console Atmosphere, declined); a decisive focus state so a selected alert commits while the rest recedes (Title Card Wall, declined); one reference strip held permanently level while content scrolls (Gravity Rain Garden, declined).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

HARTS wordmark is supplied and binding (public/harts-logo-on-*.png); no brand guide exists, so no palette or type may be presented as an official HARTS value. Craft bar set by the user: financial and data products — Bloomberg, Stripe, Mercury, Ramp. Light is primary (daylight office, laptop, sometimes projected); the dark theme keeps working. The eight-slot chart palette is colourblind-validated and may not be re-ordered without re-running the validator. No webfont: Operate is well served by system stacks, and the form's character comes from setting, rules and figures rather than a display face.

## Unresolved

Whether the CEO ever needs a print or PDF export of the dashboard; the form would carry it almost for free.
