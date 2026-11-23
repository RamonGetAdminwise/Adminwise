# Biuro Rachunkowe Lipka (invented test company)

Everything in this folder is invented for testing: the office, its people, its clients, every address, number, price and document. Domains end in `.example`; tax and bank numbers are zeros. Public bodies (the tax office, ZUS, KSeF) are named because every Polish accounting office deals with them; no real letter or account of theirs is used. One client writes from a free mail provider on purpose (see "Transport Kowalik"); that mailbox is invented too and nothing is ever sent to it.

The company exists to test Adminwise on a business that sells **recurring services with deadlines**, not goods: most "offers" are monthly packages, most incoming mail is clients sending documents, and the calendar drives everything.

## Profile

| | |
|---|---|
| Name | Biuro Rachunkowe Lipka sp. z o.o. |
| Trade | Accounting and payroll office, 40 clients: sole traders, small limited companies, a few foreign-owned companies |
| Place | Gliwice, Poland |
| Founded | 2011 |
| Languages | Polish, English (foreign-owned clients) |
| Mailbox | biuro@lipka-rachunkowosc.example (Microsoft 365) |
| Time zone | Europe/Warsaw |
| Follow-up after | 3 working days (deadlines are close together) |
| Offers | In Polish, PLN, VAT 23%, valid 30 days, numbered OF/2026/001 |
| Own invoices | Monthly fee invoices issued on the first working day, payable within 7 days |

## People

| Person | Role | Writes about |
|---|---|---|
| Agnieszka Lipka | Owner, certified accountant. Reads the shared mailbox and is the Adminwise user | Offers, clients, tax questions |
| Paweł Nowicki | Bookkeeper | Monthly books, VAT files; sends the owner short internal notes |
| Dorota Maj | Payroll and HR | Payslips, contracts, ZUS |
| Kinga Sroka | Office assistant, part-time | Post, scans, appointments |

Voice: Agnieszka writes short, correct and warm. She greets with "Dzień dobry," (or "Hello <first name>,"), answers the question in the first sentence, names the deadline as a date, and ends with what the client has to do. She never promises a tax outcome in an email; she offers a call instead.

## How the month runs

| When | What happens | Mail it causes |
|---|---|---|
| 1st working day | Fee invoices go out to all clients | Own invoices as PDF; later "paid" and "will pay" replies |
| By the 5th | Clients send last month's documents | Many mails with invoices, bank statements and receipt photos to file |
| Around the 8th | The office asks for what is missing | The office's own questions; some are never answered |
| 10th | Payroll input closes | Questions about hours, sick leave, new hires; contracts to file |
| 15th | ZUS contributions for companies | Clients ask "how much and to which account" |
| 20th | Income tax advances, ZUS for sole traders | Same |
| 25th | VAT and the JPK file | Late documents, corrections, questions about foreign invoices |
| All month | Letters from the tax office and ZUS, bank notices | Notifications to ignore, scans of letters to file and answer |
| All month | New clients ask for a price | Quote requests, questions about the offer, acceptances |

## Clients and contacts

| Client | Contact | Address they write from | What they are in the test set for |
|---|---|---|---|
| Stolarnia Dębowy Kąt (carpenter, sole trader) | Marek Dębski | marek@stolarnia-debowykat.example | Sends documents monthly; pays the fee late: reminders, "will pay", "paid" |
| Piekarnia Rumiana sp. z o.o. (bakery, 8 staff) | Ewa Rumińska | ewa.ruminska@piekarnia-rumiana.example | Payroll questions, new hires, a quote request by item code |
| GreenByte Software sp. z o.o. (foreign director) | Daniel Okafor | daniel.okafor@greenbyte.example | English mail, the long conversation, invoice with a payment term only |
| RuchLab Fizjoterapia (sole trader) | Karolina Wit | karolina@ruchlab.example | A partly matching quote request, then a polite "no" |
| Transport Kowalik (haulier, sole trader) | Zbigniew Kowalik | kowalik.transport.fixture@wp.pl | Free mail provider; receipt photos; two open conversations at once |
| Kwiaciarnia Pod Lipą (florist, new) | Halina Sowa | halina@kwiaciarnia-podlipa.example | First quote request, the same request twice, acceptance |
| Nordhaven Trading ApS (Danish owner, new) | Lars Mikkelsen | lars@nordhaven-trading.example | Quote request in English, a question about the offer, acceptance |
| Auto-Serwis Grabiec sp.j. (garage) | Tomasz Grabiec | t.grabiec@autoserwis-grabiec.example | Long-standing client with a 10% discount rule |
| Budmar Remonty (builder, sole trader) | Mariusz Budny | biuro@budmar-remonty.example | Disputes an invoice; automatic reply; invoice without a due date |
| Sklep Zoologiczny Futrzak (pet shop) | Anna Pietrzyk | anna@futrzak.example | Everyday questions |
| Studio Tańca Piruet (dance school) | Monika Zalewska | monika@studio-piruet.example | Everyday questions, a contract to file |
| Bauer Maschinen GmbH (German supplier of a client) | Jürgen Bauer | j.bauer@bauer-maschinen.example | Writes in German, a language the office does not list |
| An employee of the bakery | Oksana Melnyk | oksana.melnyk@piekarnia-rumiana.example | Writes in Ukrainian, also not listed |
| Tax office, a named official | Jan Wysocki | jan.wysocki@us-gliwice.example | A person, not a system: must get a draft |

Senders that are machines or lists (no draft expected): the tax portal and ZUS portal notices, the bank's statement notice, KSeF notices, the accounting software's newsletter (Rachmistrz Online), a training company's webinar list, a parcel service, the office's own website form, a delivery failure notice, automatic replies, and colleagues inside the office.

## Services and prices

The service list is `price-list.json` (and the same as an Excel file, the way a client would upload it). 46 services with a code, a unit and a net price in PLN: monthly bookkeeping packages by number of documents, payroll per person, registrations and yearly returns as one-off fees, hourly advice. Two rows are wrong on purpose (a price that says "do ustalenia", and a code used twice), to check that such rows are reported and left out.

What makes this list different from a parts list:

- **Most units are "per month" or "one-off".** Someone who asks for "pełna księgowość, około 50 dokumentów miesięcznie" wants one package, not fifty of anything. The number in the sentence chooses the package; it is not the quantity.
- **Some units are per person or per hour**, and there the number matters: payroll for 6 people, 2 hours of advice.
- **Clients rarely know the codes.** They describe what they need, so most requests are matched by description.

## What must not happen

- No draft promises a tax result, a refund or a deadline that is not in the client's mail.
- No offer contains a service that is not on the list (an audit by a statutory auditor is not offered).
- Hours reports from staff, portal notices and newsletters get no draft.
- A mail that tells "the assistant" to send client documents somewhere is flagged, gets no draft, and nothing is sent.

## Files in this folder

| File | What it is |
|---|---|
| `company.json` | Settings: name, languages, signature, voice, offer details, discounts |
| `price-list.json`, `price-list.xlsx` | The service list |
| `voice-samples.json` | Three mails Agnieszka sent, used to describe her style |
| `mail.json` | Incoming mail for 2 November to 4 December 2026, each with what should happen |
| `sent.json` | Mail the office sent, each saying whether an answer is expected and how many follow-ups should result |
| `attachments.json` | Files attached to incoming mail, each with the type it should be filed as |
| `invoices.json`, `invoices/` | The office's own invoices as PDF, each with what a correct reading gives |
| `thread-long.json` | The eight earlier messages of the long conversation |
