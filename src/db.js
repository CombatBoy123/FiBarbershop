// db.js — Postgres for Fi Barbershop: staff accounts, price list, products,
// invoices, kassaraamat (cash book) and ladu (stock movements).
// Backed by `pg` against DATABASE_URL, with the schema
// created on boot with CREATE TABLE IF NOT EXISTS.

const { Pool, types } = require("pg");

// pg's default DATE parser returns a JS Date at local midnight in the server
// process's timezone, so a round trip through JSON can shift the date by a day
// whenever that timezone isn't UTC. DATE columns are date-only values with no
// timezone concept — parse them as plain 'YYYY-MM-DD' strings instead.
types.setTypeParser(1082, (val) => val);

// NUMERIC arrives as a string by default. Every amount in this app is euros
// with two decimals and well under 2^53 cents, so a Number is exact enough to
// display. Arithmetic on the server is still done in integer cents (see
// `cents` below) — this parser is for reading values out, not for summing.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const DB_URL = process.env.DATABASE_URL;

// An unset URL and an unedited placeholder both need catching. Without the
// second check pg parses "replace_this_with_..." as a hostname and the server
// dies later with "getaddrinfo ENOTFOUND base", which explains nothing.
if (!DB_URL || !/^postgres(ql)?:\/\//i.test(DB_URL)) {
  throw new Error(
    "DATABASE_URL puudub või on täitmata. Kopeeri .env.example failiks .env ja pane sinna Postgresi ühendusstring, mis algab postgresql:// . Renderis leiad selle andmebaasi lehelt (External Database URL)."
  );
}

const useSSL = /render\.com|sslmode=require/i.test(DB_URL);
const pool = new Pool({
  connectionString: DB_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

const ready = pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per user. Holds invoice header details, VAT behaviour and the
  -- invoice counter, which is allocated under a row lock so two tills can
  -- never mint the same invoice number.
  CREATE TABLE IF NOT EXISTS settings (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vat_rate         NUMERIC NOT NULL DEFAULT 24,
    show_vat         BOOLEAN NOT NULL DEFAULT true,
    ask_tip          BOOLEAN NOT NULL DEFAULT true,
    low_stock        INTEGER NOT NULL DEFAULT 3,
    opening_balance  NUMERIC NOT NULL DEFAULT 0,
    invoice_year     INTEGER NOT NULL DEFAULT 0,
    invoice_seq      INTEGER NOT NULL DEFAULT 0,
    invoice_month    TEXT,
    company_name     TEXT NOT NULL DEFAULT 'FI BARBERS OÜ',
    company_address  TEXT NOT NULL DEFAULT 'Aardla 130, 50415, Tartu, Tartumaa, Eesti',
    company_reg      TEXT NOT NULL DEFAULT '',
    company_kmkr     TEXT NOT NULL DEFAULT '',
    company_bank     TEXT NOT NULL DEFAULT '',
    company_iban     TEXT NOT NULL DEFAULT '',
    company_phone    TEXT NOT NULL DEFAULT '+37259123312',
    company_email    TEXT NOT NULL DEFAULT 'fijuuksur@gmail.com',
    company_web      TEXT NOT NULL DEFAULT 'fibarbers.ee',
    payment_days     INTEGER NOT NULL DEFAULT 14
  );

  CREATE TABLE IF NOT EXISTS services (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    price      NUMERIC NOT NULL DEFAULT 0,
    note       TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true
  );
  CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id);

  CREATE TABLE IF NOT EXISTS products (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    cost       NUMERIC NOT NULL DEFAULT 0,
    price      NUMERIC NOT NULL DEFAULT 0,
    image_url  TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true
  );
  CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);

  CREATE TABLE IF NOT EXISTS invoices (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nr            TEXT NOT NULL,
    invoice_date  DATE NOT NULL,
    due_date      DATE NOT NULL,
    buyer_name    TEXT NOT NULL DEFAULT 'Eraklient',
    buyer_details TEXT NOT NULL DEFAULT '',
    net           NUMERIC NOT NULL DEFAULT 0,
    vat           NUMERIC NOT NULL DEFAULT 0,
    vat_rate      NUMERIC NOT NULL DEFAULT 0,
    tip           NUMERIC NOT NULL DEFAULT 0,
    total         NUMERIC NOT NULL DEFAULT 0,
    cash          NUMERIC NOT NULL DEFAULT 0,
    card          NUMERIC NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at  TIMESTAMPTZ,
    cancel_reason TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, nr)
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_user_date ON invoices(user_id, invoice_date DESC);

  CREATE TABLE IF NOT EXISTS invoice_lines (
    id         SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    qty        NUMERIC NOT NULL DEFAULT 1,
    unit       TEXT NOT NULL DEFAULT 'tk',
    price      NUMERIC NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines(invoice_id);

  CREATE TABLE IF NOT EXISTS ledger_entries (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_date  DATE NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('tulu','kulu')),
    category    TEXT NOT NULL DEFAULT 'Muu',
    description TEXT NOT NULL DEFAULT '',
    cash        NUMERIC NOT NULL DEFAULT 0,
    card        NUMERIC NOT NULL DEFAULT 0,
    invoice_id  INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user_date ON ledger_entries(user_id, entry_date, id);

  CREATE TABLE IF NOT EXISTS stock_movements (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    move_date  DATE NOT NULL,
    move_type  TEXT NOT NULL CHECK (move_type IN ('in','out')),
    qty        NUMERIC NOT NULL,
    price      NUMERIC NOT NULL DEFAULT 0,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_moves_user ON stock_movements(user_id, move_date DESC, id DESC);
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_month TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS company_phone TEXT NOT NULL DEFAULT '';

  -- The seller block of the invoice was seeded with placeholders before the
  -- shop's real details were known. Only rows still carrying those exact
  -- placeholders are corrected; anything the shop has typed itself is left be.
  UPDATE settings SET company_name    = 'FI BARBERS OÜ'
    WHERE company_name IN ('', 'Fi Barbershop OÜ');
  UPDATE settings SET company_address = 'Aardla 130, 50415, Tartu, Tartumaa, Eesti'
    WHERE company_address IN ('', 'Tartu');
  UPDATE settings SET company_phone   = '+37259123312'
    WHERE company_phone = '';
  UPDATE settings SET company_email   = 'fijuuksur@gmail.com'
    WHERE company_email IN ('', 'info@fibarbers.ee');

  -- =====================================================================
  -- Arveldus 2.0. Every statement below is additive: no column is dropped
  -- and none changes meaning, so the invoices already issued stay exactly
  -- as they were.
  -- =====================================================================

  -- A line is a copy, never a reference: name and price are already written
  -- onto the line at sale time, so repricing one invoice can never move the
  -- price list. These three columns finish the thought — a description the
  -- customer can read, a per-line discount, and a link back to the service
  -- that exists only so a report can count haircuts. ON DELETE SET NULL:
  -- retiring a service must not rewrite an invoice from last year.
  ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS note       TEXT    NOT NULL DEFAULT '';
  ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS discount   NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES services(id) ON DELETE SET NULL;

  -- An invoice now has a life: mustand → esitatud → makstud, or tühistatud.
  -- 'makstud' is the default because that is what every existing invoice is —
  -- the till has always taken the money before writing the row.
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'makstud';
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at    TIMESTAMPTZ;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bank       NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  UPDATE invoices SET paid_at = created_at WHERE paid_at IS NULL AND cancelled_at IS NULL;
  UPDATE invoices SET status  = 'tühistatud' WHERE cancelled_at IS NOT NULL AND status <> 'tühistatud';

  -- A draft carries no number yet, so nr cannot stay NOT NULL. Drafts hold an
  -- empty nr and uniqueness is enforced only on rows that actually have one.
  ALTER TABLE invoices ALTER COLUMN nr DROP NOT NULL;
  ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_user_id_nr_key;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_nr
    ON invoices(user_id, nr) WHERE nr IS NOT NULL AND nr <> '';

  -- Staff. users.id keeps meaning "the shop" — every data table's user_id
  -- still points at it — and shop_id says which shop an account works for.
  -- The existing owner points at itself, so no data moves.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role    TEXT NOT NULL DEFAULT 'omanik';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS active  BOOLEAN NOT NULL DEFAULT true;
  UPDATE users SET shop_id = id WHERE shop_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id);

  -- Who did what. The only place that can answer "who cancelled 0926-004".
  CREATE TABLE IF NOT EXISTS audit_log (
    id         SERIAL PRIMARY KEY,
    shop_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_shop ON audit_log(shop_id, created_at DESC, id DESC);

  -- Regulars, and the price each has been promised. A price here is only a
  -- default the till fills in: the line still gets its own copy, so changing
  -- a customer's price never touches an invoice already written.
  CREATE TABLE IF NOT EXISTS customers (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    details    TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    active     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id, name);

  CREATE TABLE IF NOT EXISTS customer_prices (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    price       NUMERIC NOT NULL DEFAULT 0,
    UNIQUE(customer_id, service_id)
  );

  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

  -- A credit invoice is settled by transfer, which is neither the cash drawer
  -- nor the card terminal. Booking it as either would put money in a place it
  -- is not, so it gets its own column in the cash book too.
  ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS bank NUMERIC NOT NULL DEFAULT 0;

  -- Per-account switches for the parts of the app a barber may reach —
  -- Kliendid, Hinnakiri, Kassaraamat, Ladu, Kontod. A key that is absent
  -- falls back to the role's default, so an account nobody has touched
  -- behaves exactly as it did before this column existed. The owner's own
  -- row is never consulted: an owner always has everything.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
`);

// Every amount crossing this app is euros with two decimals. Summing floats
// drifts (0.1 + 0.2), so all server-side arithmetic happens in integer cents
// and converts back once at the end.
const cents = (v) => Math.round(Number(v || 0) * 100);
const euros = (c) => Math.round(c) / 100;

async function query(text, params) {
  await ready;
  return pool.query(text, params);
}

// Runs fn inside a transaction, rolling back on any throw. Used by the sale
// endpoint, where an invoice, a cash-book entry and the stock movements must
// all land together or not at all.
async function withTransaction(fn) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ready, query, withTransaction, cents, euros };
