# Fi Barbershop — kassa, arved, ladu

Salongi sisene töölaud: kiirmüük, arved, kassaraamat ja ladu. Eestikeelne,
hele ja tume teema. Andmed on Postgresis, seega igas seadmes on sama seis.

Kliendid seda ei näe — sisse pääseb ainult kontoga, mille loob omanik.

Version 2 is a rework of the app as it stood at `c9fae16`;
`git diff c9fae16` shows everything that changed. The sections below say what
and why.

---

## Running it

```bash
cp .env.example .env        # fill in DATABASE_URL and JWT_SECRET
npm install
npm start                   # migrates the database, then serves http://localhost:4100/app
```

First login (public registration is off):

```bash
SEED_EMAIL=info@fibarbers.ee SEED_PASSWORD='…' npm run seed-user
```

| Command | What it does |
| --- | --- |
| `npm start` | Bring the schema up to date, then serve the till, the API and the saved shop front |
| `npm run dev` | Same, restarting on file changes |
| `npm run migrate` | Only run pending database migrations |
| `npm test` | Unit tests, then the end-to-end smoke test against a throwaway shop |
| `npm run seed-user` | Create or reset a login (see the header of `scripts/seed-user.js`) |
| `npm run sync-products` | Pull product names, prices and photos from fibarbers.ee |

The smoke test needs a `DATABASE_URL`. It creates its own shop, runs every
flow against the real app in-process, and deletes that shop again, so it
never reads or writes the real shop's books.

## How it is put together

```
src/
  server.js        migrate, then listen; graceful shutdown on SIGTERM
  app.js           the Express app: headers, /api, static files, shop front
  config.js        every environment variable, checked once at startup
  db.js            Postgres pool, transactions, cents/euros helpers
  migrations.js    numbered schema steps, each run exactly once
  auth.js          passwords, tokens, roles and per-account permissions
  state.js         the whole till in one read; every write answers with it
  lib/
    invoicing.js   the rules every invoice obeys: lines, VAT, numbering,
                   stock, cash book, audit, viitenumber
    http.js        input parsers that refuse junk with a 400
    dates.js       "today" in the shop's timezone
  routes/          one router per area: auth, catalog, invoices, stock,
                   ledger, staff, barbers, customers, site
public/
  app.html         the till (strict CSP)
  js/              main.js (actions), state.js (store + derived figures),
                   views.js (screens), dialog.js (modal), api.js, util.js
  site/            saved copy of the public shop front
```

### Invoices

* **Till sale** (`POST /api/sales`): number, stock movement and cash-book
  entry in one transaction.
* **Draft** (`POST/PUT /api/invoices`): no number, no stock movement, nothing
  in the cash book. Can be edited over days and deleted freely.
* **Issue** (`POST /api/invoices/:id/issue`): the number is minted, stock
  leaves the shelf once, and either the money is taken or the invoice goes
  out on credit.
* **Pay** (`POST /api/invoices/:id/pay`): a credit invoice reaches the cash
  book when the money arrives.
* **Cancel / un-cancel / delete for good**: owner only, all audited.

Invoice numbers are `MMYY-NNN`: the month's highest issued number plus one,
minted under a row lock on the shop's settings. Stock is checked per product
(all lines together) with the product rows locked.

### Barbers at the till

The barber picker is part of the till itself, above the service tiles. Each
tile shows what the barber in the chair charges (from `barber_prices`, by
service id) and is struck out when that barber does not perform the service.
The choice is remembered per browser. A login linked to a barber (under
Kontod) sees only its own name. A line's price is: the customer's agreed
price, else the barber's price, else the shop's price.

### Migrations

`src/migrations.js` holds numbered steps recorded in `schema_migrations`.
Never edit a step that has shipped; add a new one. Several instances starting
at once are serialised with an advisory lock.

## What changed in the rework

Every bug below was reproduced against the original code before being fixed,
and each has a regression check in `scripts/smoke-test.js` (section 11).

**Money and stock**
* Drafts took goods off the shelf on save, again on every edit, and again on
  issue (5 on the shelf → 2 instead of 4). Drafts now move nothing.
* Stock was checked line by line, so six 1-unit lines sold against 2 on the
  shelf and left it at −4.
* One invoice dated into another month reset the numbering counter; every
  sale after that failed with a server error until someone fixed the database.
* On every server restart, unpaid invoices were stamped as paid; cancelling
  and un-cancelling one then turned it into a paid invoice.
* Negative cash on a sale, and paying more than owed on a credit invoice
  (which produced a negative transfer), were accepted.
* The cash-book form's transfer field was never sent to the server.
* The printed viitenumber had no 7-3-1 check digit, so banks reject it.
* "Today" on the server was UTC: entries made after midnight in Tartu landed on
  the previous day.
* A low-stock limit of 0 was silently treated as 3.

**Accounts and security**
* Typing the wrong current password under "Minu parool" signed the user out.
* A password reset or a closed account left existing 30-day sessions working.
  Changing a password now ends every other session of that account.
* A second owner could close or demote the account the shop was created with.
* Bad ids, dates and quantities reached Postgres and came back as 500s; a
  product id from another shop could be written onto an invoice line.
* A wrong email was answered faster than a wrong password, which showed which
  addresses have accounts.
* `/app.html` served the till without its Content-Security-Policy, and `/app/`
  served the page in place of its own CSS and scripts.

**The till**
* The barber picker was a separate script that read the page's DOM, guessed
  services by keywords ("habe", "lõik"), and rewrote prices by firing fake
  input events. A new service such as "Laste lõikus" got the adult haircut
  price, and the chosen barber was forgotten on every reload. Replaced by the
  built-in picker described above.
* A customer's agreed price only applied to lines already on the invoice, not
  to lines added after the customer was picked.
* `prompt()`/`confirm()` replaced with one dialog: cancelling an invoice asks
  for the number and the reason together, and the dangerous button is marked.
* Hinnakiri can now add, rename and remove services, products and barbers (the
  API existed; the screen could only change prices). A new service is offered
  by every barber at the shop price.
* Kliendid: customer details can be edited, and agreed prices can be set by
  anyone with the Kliendid permission (what the server already allowed).
* Kassaraamat is shown a month at a time with a month-end balance.
* Deleting a cash-book entry or a stock movement by hand, and every stocktake,
  now leaves an audit row.
* The contact, cart and language forms on the saved shop pages posted to
  paths this server did not handle; they now reach the live shop.

## Upgrading an existing database

On first start against the production database, migrations 3 and 4 repair
data the old bugs already damaged:

* unpaid invoices and drafts lose the payment date that restarts stamped on
  them; an unpaid invoice that became "makstud" through cancel + un-cancel
  goes back to unpaid, and its zero-amount cash-book row is removed;
* stock movements written by saving drafts are removed, so the shelf
  figures go back to what was actually sold.

This was tested by corrupting a database with the original code and then
starting this version on it. **Take a backup before pointing this at the real
database** (Render: Postgres → Backups). Movements from drafts that were
deleted before the upgrade cannot be told apart from manual ones and are left
alone. If a shelf figure still looks wrong, correct it with a stocktake under
Ladu.

Sessions from before the upgrade stay valid until their password changes.
