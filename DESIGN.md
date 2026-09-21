# Design

The visual system, written from the built app rather than ahead of it.

## The world: The Statement

This is read the way printed accounts are read, so it is set that way. The
governing idea is that a figure is only worth as much as a reader's ability to
challenge it, so the system is built to make every number locatable,
comparable, and traceable to its method.

It refuses the arrangement this app used to have and that most internal
dashboards have: a grid of same-size white cards with soft borders, rounded
corners, a shadow for separation and a KPI row across the top, where every
section shouts at the same volume and nothing is subordinate to anything.

Three rules carry it. Breaking any of them is what makes an interface look
assembled rather than set.

1. **A 1px rule does every job a border, a box and a shadow used to do.**
   Nothing is a container with four sides. Sections are separated, not
   enclosed. `.card` is deliberately a no-op: a label, a rule, and content on
   the page's own ground.
2. **Every figure is tabular-lined.** Money that does not align down a column
   cannot be compared, and comparing is the job. Applied globally by selector,
   not opted into table by table.
3. **One accent, and it means "you can act on this."** The chart palette is a
   separate validated system that never leaks into chrome. Red is reserved for
   money at risk.

## Colour

Strategy: **Restrained** — neutrals plus one accent. Correct for a surface
someone operates daily; the expression lives in setting, not saturation.

Light is primary. The scene forced it: a daylight office, a laptop, and
occasionally a projector in front of the CEO. Dark is a selected set of steps
for a dark ground, never an inversion of the light one.

### Ground and ink

| Role | Light | Dark |
|---|---|---|
| Page plane | `#fbfbfc` | `#0c0d10` |
| Sheet / control surface | `#ffffff` | `#141619` |
| Primary ink | `#0a0c10` | `#f2f4f7` |
| Secondary ink | `#4a5058` | `#a8aeb8` |
| Muted (labels, axes) | `#868d96` | `#757c86` |
| Rule (hairline) | `#e3e5e9` | `#272a30` |
| Rule, strong (section, table head) | `#c8ccd3` | `#3a3e46` |

The ground is **cool**, not cream. A warm paper ground with a serif display and
a terracotta accent is the most common signature of a generated interface; this
system stays away from it on purpose.

### Accent

| Role | Light | Dark |
|---|---|---|
| Accent | `#1b4b8f` | `#6ba3e8` |
| Accent hover | `#153c73` | `#8bb8ee` |
| Accent wash (focus ring) | `#eef3fa` | `#16243a` |

Used only for what is interactive: links, primary buttons, focus rings, and the
active nav rule. It never appears as decoration.

### Series (charts only)

Eight categorical slots in a **validated order**. The order is the
colourblind-safety mechanism, not a preference: adjacent pairs are what a
stacked bar or multi-line chart puts side by side, and this sequence clears
every adjacent gate in both modes — worst adjacent CVD ΔE 9.1 light / 8.4 dark,
worst adjacent normal-vision ΔE 19.6 light / 19.3 dark.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Constraints that travel with it:

- **Re-ordering requires re-running the validator**, not taste.
- Slots 3, 4 and 5 sit below 3:1 on the light surface. Anything wearing them
  ships a visible label — the relief rule. Our charts direct-label already.
- All-pairs forms (scatter, anything where every series meets every other) cap
  at the **first three slots**. Past three, fold to "Other" or facet.
- A single-measure chart uses one hue and no legend; the title names it.

### Status (fixed, never themed)

`good #0ca30c` · `warning #fab219` · `serious #ec835a` · `critical #d03b3b`.

Deliberately distinct from the series slots so a status never impersonates a
series. Warning and serious sit below 3:1 on the light surface by design, so
every status ships an **icon and a text label** — colour never carries meaning
alone. The three severity icons differ in silhouette, not just hue, so severity
survives greyscale.

## Type

System stack throughout: `system-ui, -apple-system, 'Segoe UI', sans-serif`.
No webfont. An Operate surface is well served by a system stack, and this
world's character comes from setting — rules, tracked labels, aligned figures —
rather than from a display face. A mono stack exists for code fragments only.

| Role | Size | Weight | Treatment |
|---|---|---|---|
| Lead figure | `clamp(38px, 5.2vw, 56px)` | 600 | -0.035em, tabular |
| Page title (`.card-head h1`) | 22px | 600 | -0.02em |
| Section label (`.card-head h2`) | 11px | 650 | uppercase, 0.07em tracked |
| Body | 13.5px | 400 | 1.55 line-height |
| Figure (stat, compare) | 15–28px | 600–620 | tabular |
| Small label / column head | 10.5px | 620 | uppercase, 0.07em tracked |

**The section label is the signature.** Small, tracked, uppercase, sitting above
its own rule. One selector applies it to every section label, nav group, table
head, field group and detail term in the app, which is what makes pages read as
set rather than stacked.

## Structure

- **Sections, not cards.** `.card` carries no background, border, radius or
  padding. Identity comes from `.card-head`: label, optional right-aligned hint,
  and a bottom rule.
- **Statement header.** Sheet name left, `As at <date>` right, one rule under,
  sticky. It is the fixed reference the page is read against while content
  scrolls.
- **Column gutters are ruled.** Two sections side by side get a 44px gutter and
  a hairline between them, above 900px only. Without it the columns read as one
  ragged block — the ambiguity a card's border used to resolve.
- **Tables** rule under the head at `--rule-strong` and between rows at
  `--rule`. Numeric columns right-align. No zebra striping; the rules do it.
- **Radius** never exceeds 4px, and 3px on controls. A statement is not a
  rounded rectangle.

## Prohibitions

These are not preferences; each is a specific failure this system was built to
avoid.

- **No thick coloured border on one side of a card, notice or list item.** The
  single most recognisable tell of a generated interface. Notices use a hairline
  rule *above* them in the status colour instead. The design detector enforces
  this; it caught one during the build.
- **No shadow as a separation device.** Rules separate.
- **No gradient text, no glass, no decorative blur.**
- **No emoji or Unicode glyph standing in for an icon.** Icons are authored SVG
  on one 24px grid at one stroke weight (`components/icons.tsx`).
- **No warm cream ground.**
- **Colour never carries meaning alone.** Status pairs with an icon and a label;
  chart series pair with a direct label.

## Motion

One authored moment: the sheet settles once on load, 340ms on an exponential
ease-out, staggered to 120ms maximum. It starts from a visible state so a failed
animation leaves a usable page, and the whole block sits inside
`prefers-reduced-motion: no-preference`.

Interaction motion is 120ms on colour and border only. Nothing else moves.

## Provenance, as a system feature

Every figure in this app is derived — converted, annualised, averaged, or
restricted to complete months — and the system treats saying so as part of the
design rather than a disclaimer.

- Converted figures state their basis in the section that carries them.
- "How the spend figures were made" is a real section, set quiet.
- `<Explain>` (`components/Explain.tsx`) folds what a chart shows, how it is
  calculated, and why it matters under a disclosure, so a daily reader is not
  made to scroll past the method every morning.
- Amounts that could not be converted are named on screen rather than dropped.

## Accessibility

- Body and placeholder text clear 4.5:1; large text clears 3:1.
- Focus rings are a 2px accent outline at 2px offset, on every interactive
  element, never removed.
- The three severity icons differ in shape, not only colour.
- Charts are direct-labelled; a table view exists for the figures behind them.
- Browser surfaces — selection, caret, scrollbars — are themed from the
  palette rather than left at the OS accent.

## Where this lives

`src/client/styles.css` is the whole system; there is no second source. The
direction contract that produced it is in `.impeccable/surfaces/src-client.md`.
