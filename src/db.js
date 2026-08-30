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
    company_name     TEXT NOT NULL DEFAULT 'Fi Barbershop OÜ',
    company_address  TEXT NOT NULL DEFAULT 'Tartu',
    company_reg      TEXT NOT NULL DEFAULT '',
    company_kmkr     TEXT NOT NULL DEFAULT '',
    company_bank     TEXT NOT NULL DEFAULT '',
    company_iban     TEXT NOT NULL DEFAULT '',
    company_email    TEXT NOT NULL DEFAULT 'info@fibarbers.ee',
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
