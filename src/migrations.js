// migrations.js — the schema, as an ordered list of numbered steps that each
// run exactly once per database.
//
// The old db.js ran one big SQL string on every boot, data fixes included.
// Schema statements survive that (they are IF NOT EXISTS), data fixes do not:
// "UPDATE invoices SET paid_at = created_at WHERE paid_at IS NULL" was meant
// to fill in old rows once, but ran on every restart and stamped every unpaid
// invoice as paid. Cancelling and un-cancelling such an invoice then turned it
// into a paid one with its own cash-book entry. Steps here are recorded in
// schema_migrations, so a backfill runs once and never again.
//
// Rules for adding a step: append, never edit or reorder a step that has
// shipped; keep every step safe to run against the production database as it
// stands today.

const { pool } = require("./db");

const MIGRATIONS = [
  {
    id: 1,
    name: "baseline schema",
    // Exactly the schema the old boot script produced, minus its data
    // updates. Everything is IF NOT EXISTS, so this is a no-op on the database
    // already in production and a full build on an empty one.
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name          TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

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

      ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS note       TEXT    NOT NULL DEFAULT '';
      ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS discount   NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES services(id) ON DELETE SET NULL;

      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'makstud';
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at    TIMESTAMPTZ;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bank       NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

      ALTER TABLE invoices ALTER COLUMN nr DROP NOT NULL;
      ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_user_id_nr_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_nr
        ON invoices(user_id, nr) WHERE nr IS NOT NULL AND nr <> '';

      ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role    TEXT NOT NULL DEFAULT 'omanik';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS active  BOOLEAN NOT NULL DEFAULT true;
      CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id);

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
      ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS bank NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS barbers (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug       TEXT NOT NULL,
        name       TEXT NOT NULL,
        tier       TEXT NOT NULL DEFAULT '',
        phone      TEXT NOT NULL DEFAULT '',
        account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active     BOOLEAN NOT NULL DEFAULT true,
        UNIQUE(user_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_barbers_user ON barbers(user_id, sort_order, id);

      ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS barber_prices (
        id         SERIAL PRIMARY KEY,
        barber_id  INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        price      NUMERIC NOT NULL DEFAULT 0,
        offered    BOOLEAN NOT NULL DEFAULT true,
        UNIQUE(barber_id, service_id)
      );
    `,
  },

  {
    id: 2,
    name: "one-time backfills from the old boot script",
    // The same data fixes the old boot script ran every time, run once here —
    // with the paid_at backfill narrowed to what it was always meant for:
    // invoices that are actually paid. Drafts and unpaid invoices keep NULL.
    sql: `
      UPDATE users SET shop_id = id WHERE shop_id IS NULL;

      UPDATE settings SET company_name    = 'FI BARBERS OÜ'
        WHERE company_name IN ('', 'Fi Barbershop OÜ');
      UPDATE settings SET company_address = 'Aardla 130, 50415, Tartu, Tartumaa, Eesti'
        WHERE company_address IN ('', 'Tartu');
      UPDATE settings SET company_phone   = '+37259123312'
        WHERE company_phone = '';
      UPDATE settings SET company_email   = 'fijuuksur@gmail.com'
        WHERE company_email IN ('', 'info@fibarbers.ee');

      UPDATE invoices SET status = 'tühistatud'
        WHERE cancelled_at IS NOT NULL AND status <> 'tühistatud';
      UPDATE invoices SET paid_at = created_at
        WHERE paid_at IS NULL AND status = 'makstud';
    `,
  },

  {
    id: 3,
    name: "repair: unpaid invoices stamped as paid on every restart",
    // Undo what the every-boot backfill did. A draft or an unpaid invoice has
    // no payment date. A cancelled invoice gets its payment date back only
    // when the audit trail shows it was issued unpaid and never paid.
    //
    // An invoice issued unpaid, never marked paid, but reading 'makstud' can
    // only have got there through un-cancelling with that bogus payment date.
    // It goes back to unpaid, and the zero-amount cash-book row the
    // un-cancel wrote for it goes with it.
    sql: `
      UPDATE invoices SET paid_at = NULL WHERE status IN ('mustand', 'esitatud') AND paid_at IS NOT NULL;

      UPDATE invoices i SET paid_at = NULL
       WHERE i.status = 'tühistatud' AND i.paid_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM audit_log a WHERE a.invoice_id = i.id AND a.action = 'arve esitatud')
         AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.invoice_id = i.id
                          AND a.action IN ('arve makstud', 'arve esitatud ja makstud'));

      WITH wrong AS (
        SELECT i.id FROM invoices i
         WHERE i.status = 'makstud'
           AND EXISTS (SELECT 1 FROM audit_log a WHERE a.invoice_id = i.id AND a.action = 'arve esitatud')
           AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.invoice_id = i.id
                            AND a.action IN ('arve makstud', 'arve esitatud ja makstud'))
      ), fixed AS (
        UPDATE invoices SET status = 'esitatud', paid_at = NULL
         WHERE id IN (SELECT id FROM wrong) RETURNING id
      )
      DELETE FROM ledger_entries
       WHERE invoice_id IN (SELECT id FROM fixed) AND cash = 0 AND card = 0 AND bank = 0;
    `,
  },

  {
    id: 4,
    name: "repair: stock taken off the shelf by drafts",
    // Saving a draft wrote a stock movement for every product line, and so did
    // every later edit of it, and then issuing wrote them once more — a jar on
    // a draft edited twice came off the shelf three times.
    //
    // Movements still attached to a draft are all of that kind. For an issued
    // invoice, the real ones were written in the same transaction as its
    // 'arve esitatud' audit row and share its timestamp; anything older on
    // that invoice came from saving the draft.
    sql: `
      DELETE FROM stock_movements m
       USING invoices i
       WHERE m.invoice_id = i.id AND i.status = 'mustand';

      DELETE FROM stock_movements m
       USING (SELECT invoice_id, MIN(created_at) AS issued_at FROM audit_log
               WHERE action IN ('arve esitatud', 'arve esitatud ja makstud') AND invoice_id IS NOT NULL
               GROUP BY invoice_id) a
       WHERE m.invoice_id = a.invoice_id AND m.created_at < a.issued_at;
    `,
  },

  {
    id: 5,
    name: "sessions end when a password changes",
    // Tokens live for 30 days. Without this, resetting the password of a
    // barber whose login leaked left the leaked session working for a month.
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_changed_at TIMESTAMPTZ;`,
  },
];

// Several instances booting at once (a Render deploy overlaps the old one)
// must not run the same step twice: the advisory lock makes the second wait
// until the first has finished, and it then finds nothing left to do.
const LOCK_KEY = 4102026;

async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));

    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
        await client.query("COMMIT");
        log("Andmebaas: rakendatud samm " + m.id + " — " + m.name);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        err.message = "Andmebaasi samm " + m.id + " (" + m.name + ") ebaõnnestus: " + err.message;
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// One shared promise, so every caller in a process waits for the same run.
let running = null;
const ready = () => running || (running = migrate());

module.exports = { MIGRATIONS, migrate, ready };
