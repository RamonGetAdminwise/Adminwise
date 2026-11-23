# Adminwise house style

Decided on 23 November 2026. The brief was: neat, clean, professional and fresh. This page is the reference for the website, the app and anything else that carries the name. The values live in code in `apps/web/src/app/globals.css` (colours, fonts) and `apps/web/src/components/logo.tsx` (logo).

## The idea in one line

Calm and light, with one fresh green. The product takes work off someone's desk, so the look is uncluttered: a lot of white, one accent colour, clear type, and pictures of the real product instead of stock photos or illustrations.

## Logo

- **Mark:** a lowercase "a" whose bowl holds a tick, in white on a rounded square in Evergreen 600. It reads as "a" for Adminwise and as "done".
- **Wordmark:** the name in lowercase, Plus Jakarta Sans Bold: "admin" in Ink, "wise" in Evergreen 600. On dark backgrounds: "admin" in white, "wise" in Evergreen 300.
- **Use:** mark and wordmark together wherever there is room; the mark alone as the browser icon and in small places.
- **Clear space:** half the mark's width on every side. **Smallest size:** mark 16 px; logo 20 px high.
- **Do not:** stretch it, change its colours, put it on a busy photo, add a shadow or an outline, or write the name with a capital in the logo. In running text the name is written "Adminwise".

Files: `01_Project_docs/brand/adminwise-mark.svg`, `adminwise-logo.svg`, `adminwise-logo-on-dark.svg`. The wordmark in those files is live text in Plus Jakarta Sans; for print or for a place without that font, have the letters converted to outlines first.

## Colours

| Name | Value | Use |
|---|---|---|
| Evergreen 600 | `#0b855b` | The accent: logo, main buttons, the highlighted word in a headline |
| Evergreen 700 | `#0a6b4a` | Buttons when hovered, small labels above headings, links |
| Evergreen 950 | `#072a20` | Dark bands: footer, the data block |
| Evergreen 50 / 100 | `#ecfaf4` / `#d3f3e4` | Soft backgrounds, tick circles, notices |
| Evergreen 300 | `#6fd3ab` | Accents on dark backgrounds |
| Ink | `#0e2420` | Text and headings |
| Stone 50 to 900 | `#f6f9f8` to `#16211e` | Neutrals, with a slight green bias: page background, lines, secondary text |
| Sun 100 / 500 / 700 | `#fdf0cf` / `#e5a019` / `#9a6508` | Only for "needs attention": overdue, waiting. Never as decoration |

Rules: one accent colour per screen. White or Stone 50 as the ground. Red only for errors.

## Type

- **Headings:** Plus Jakarta Sans, 600 to 800, tight letter spacing. Friendly and geometric.
- **Text:** Inter, 400 to 600.
- **Numbers in tables and prices:** tabular figures.
- Both fonts are downloaded when the app is built and served from our own address; a visitor's browser does not call Google.

## Shapes

- Corners: 8 px on buttons and fields, 12 px on cards, 16 to 24 px on large panels.
- Thin Stone 200 lines and soft shadows; no heavy borders.
- Product pictures are drawn in HTML as small "windows" with invented data, marked "example".

## Voice

- Plain, short sentences. Say what the product does, with the customer as the one who acts: "You check and send."
- Promise only what works today.
- No customer logos, user numbers or quotes until they are real.

## What comparable companies do (looked at on 23 November 2026)

Fyxer, Inbox Zero, Bonsai, Moneybird and Pleo. What they have in common, and what was taken as a pattern (no text, picture or design was copied):

- A light page with one accent colour and a large, bold headline in a geometric typeface.
- The product shown at work right under the headline, as realistic screens, not as illustrations.
- One main button ("start free") repeated in the header, the hero, the plans and at the end.
- A "works with" row naming the tools people already use.
- Each feature as its own section: a short heading, three points, a product picture beside it.
- "Start in minutes" as three numbered steps.
- Plans on cards with the recommended one highlighted, then questions, then a closing call to action.
- Customer logos, counts and quotes. Adminwise has none yet, so that section is left out until it can be filled honestly.
