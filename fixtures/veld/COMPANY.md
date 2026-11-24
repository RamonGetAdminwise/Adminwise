# Studio Veld (invented test company)

Everything in this folder is invented for testing: the studio, its people, its clients and suppliers, every address, number, rate and document. Domains end in `.example`; chamber of commerce, VAT and bank numbers are zeros.

The company exists to test Adminwise on a business that sells **time and projects**, in **Dutch and English**, in **euros with Dutch VAT**, and whose owner wants drafts **only for sales mail**. It is as far from a Polish parts trader as a small company gets.

## Profile

| | |
|---|---|
| Name | Studio Veld B.V. |
| Trade | Design and marketing agency: brand identities, websites, print, social media, film |
| Place | Eindhoven, the Netherlands |
| Founded | 2016 |
| Languages | Dutch, English |
| Mailbox | hallo@studioveld.example (Microsoft 365) |
| Time zone | Europe/Amsterdam |
| Reply drafts | **Sales mail only**: quote requests, accepted offers and replies about unpaid invoices. The owner writes her own creative mail |
| Follow-up after | 5 working days |
| Offers | Document in English (Adminwise has no Dutch offer document yet), EUR, VAT 21%, valid 14 days, numbered SV-2026-001 |
| Own invoices | Per project (half up front) and monthly for retainers, payable within 14 days |

## People

| Person | Role | Writes about |
|---|---|---|
| Sanne Veldhuis | Owner and creative director. Reads the shared mailbox and is the Adminwise user | Offers, clients, money |
| Joris de Wit | Partner, strategy | Workshops, pitches; short internal notes |
| Mila Janssen | Designer | Design files, feedback rounds |
| Noor El Amrani | Office and project manager, part-time | Planning, invoices, suppliers |
| Thijs Bakker | Freelance developer (not staff: his own domain) | His monthly invoice |

Voice: Sanne writes informally ("Hoi Ruud," in Dutch, "Hi Emma," in English), uses "je" and "jij", short sentences, concrete next steps, and never a price in the mail when an offer is attached. She closes with "Groet, Sanne" or "Best, Sanne".

## How work moves through the studio

| Step | What happens | Mail it causes |
|---|---|---|
| Enquiry | Someone asks what a logo, a website or a campaign costs | Quote requests: described in words, sometimes with hours or days, rarely with a code |
| Offer | The studio sends a priced proposal | Questions about the offer, "akkoord", or silence |
| Start | Contract or purchase order from larger clients; half the fee invoiced | Signed contracts and purchase orders to file; the studio's own invoices |
| Making | Feedback rounds on designs, scripts and texts | A lot of client mail the owner answers herself (no draft wanted) |
| Suppliers | Printer, freelancer, stock photos, fonts, hosting | Supplier offers and invoices to file; receipts; notices |
| Delivery | Final files, last invoice | Late payers: reminders, "will pay this week", "paid" |
| Retainers | Social media and website maintenance, invoiced monthly | Monthly invoices; requests to move a post |

## Clients, prospects and suppliers

| Who | Contact | Address they write from | What they are in the test set for |
|---|---|---|---|
| Fietsenmaker De Ketting (bike shop, new) | Ruud Smeets | ruud@deketting.example | Quote for a logo and a website, a question about the offer, acceptance |
| Brightwell Health Ltd (UK, new) | Emma Clarke | emma.clarke@brightwell-health.example | Quote request in English, acceptance, request by item code, invoice with a payment term only, "paid" |
| Stichting Zomerpodium (festival foundation) | Daan Kuipers | daan@zomerpodium.example | 15% discount rule for cultural clients; acceptance; two scans with the same name |
| Tandartspraktijk Wit (dentist) | Femke Wit | info@tandartswit.example | Website quote; "send your rate card" (not a quote request); invoice with 30 days |
| TechnoPlast B.V. (plastics manufacturer) | Ingrid Maas | i.maas@technoplast.example | Trade fair wall and film; the long conversation; purchase order; signed contract; dispute; invoice without due date |
| Bakkerij Van Dam (bakery, retainer) | Petra van Dam | petra@bakkerijvandam.example | Pays late: reminders, promise, "paid"; answers a question in a new mail instead of in the conversation |
| Kaffeehaus Lenz (Aachen, Germany) | Sabine Lenz | s.lenz@kaffeehaus-lenz.example | German, a language the studio does not list: packaging quote, hours quote, two unanswered questions |
| Maison Colette (Liège, Belgium) | Colette Dubois | contact@maison-colette.example | French, not listed, an ordinary question: no draft in "sales mail only" |
| Sportschool Fit040 (gym, new) | Bram Hendriks | bram@fit040.example | Unclear request, then the answer that makes it clear |
| Kringloop Woensel (thrift shop) | Lotte Vermeer | lotte@kringloopwoensel.example | A service the studio does not sell; hours plus a rush fee |
| Drukkerij Lumen (printer) | Kees Brouwer | kees@drukkerijlumen.example | Supplier offer and invoice to file; the same invoice twice |
| Thijs Bakker (freelancer) | Thijs Bakker | thijs@thijsbakker.example | His monthly invoices to file |

Senders that are machines or lists (no draft expected): the hosting company, the time-tracking tool, the project board, the stock photo shop's receipts, the font shop's licence mail, a trade newsletter, the studio's own website form, a delivery failure notice, automatic replies, and colleagues.

## Rate card

`price-list.json` (and the same as an Excel file): 40 services with a code, a unit and a net rate in EUR. Two rows are wrong on purpose (travel costs with a rate that is not a number, and a code used twice).

What makes this list different:

- **Three kinds of unit.** Per hour and per day (the number matters: "2 days of photography"), per piece (flyers, posters: the number matters), and per project or per month (one is meant: "a website of about 8 pages").
- **Packages by size.** A logo with one concept or three; a website up to 5 or up to 10 pages; 8 or 16 posts a month. A request has to be matched to the right size, or asked about when it does not say.
- **Dutch names, English other names.** Foreign clients ask in English and German.

## What must not happen

- No draft for the daily back-and-forth about designs: the owner chose drafts for sales mail only.
- No offer line for something that is not on the rate card (a radio commercial).
- No price in the text of a reply; prices are in the offer document only.
- The website's contact form arrives from a no-reply address and gets no draft, even when it contains a quote request. This is a known limit, listed in `docs/TO_VERIFY.md`.
- When a client answers a question in a new mail instead of in the same conversation, the follow-up is still drafted. Also a known limit.

## Files in this folder

Same layout as `fixtures/lipka/`: `company.json`, `price-list.json` and `.xlsx`, `voice-samples.json`, `mail.json` (60 incoming mails), `sent.json`, `attachments.json`, `invoices.json` and `invoices/`, `thread-long.json`.
