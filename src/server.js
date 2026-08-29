// server.js — Fi Barbershop back office.
// Serves public/ and a small JSON API. Everything is scoped to the logged-in
// user_id: two shops on the same instance never see each other's books.

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const { query, withTransaction, cents, euros } = require("./db");
const { hashPassword, verifyPassword, signToken, requireAuth } = require("./auth");
const { seedDefaults } = require("./seed");

const app = express();
const PORT = process.env.PORT || 4100;

const allowed = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: allowed.includes("*") ? "*" : allowed }));
app.use(express.json({ limit: "256kb" }));

// ------------------------------------------------------------------- utils

const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Wraps an async route so a rejected promise becomes a handled error response
// instead of an unhandled rejection that silently kills the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------- login

// Crude but effective brute-force guard: a handful of failures per email locks
// that email out for a few minutes. In-memory, so it resets on deploy — which
// is fine for a single shop's till.
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;

function loginBlocked(email) {
  const rec = failures.get(email);
  if (!rec) return false;
  if (Date.now() - rec.at > LOCK_MS) {
    failures.delete(email);
    return false;
  }
  return rec.n >= LOCK_AFTER;
}

function noteFailure(email) {
  const rec = failures.get(email);
  if (!rec || Date.now() - rec.at > LOCK_MS) failures.set(email, { n: 1, at: Date.now() });
  else failures.set(email, { n: rec.n + 1, at: Date.now() });
}

app.post(
  "/api/register",
  wrap(async (req, res) => {
    if (process.env.ALLOW_PUBLIC_REGISTER !== "1") {
      return res.status(403).json({ error: "Registreerimine on suletud. Konto loob salongi omanik." });
    }
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim();
    if (!isEmail(email)) return res.status(400).json({ error: "Vigane e-posti aadress." });
    if (password.length < 8) return res.status(400).json({ error: "Parool peab olema vähemalt 8 tähemärki." });

    const exists = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (exists.rowCount) return res.status(409).json({ error: "Selle e-postiga konto on juba olemas." });

    const user = await withTransaction(async (client) => {
      const r = await client.query(
        "INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name",
        [email, await hashPassword(password), name || null]
      );
      await seedDefaults(client, r.rows[0].id);
      return r.rows[0];
    });

    res.status(201).json({ token: signToken(user), user });
  })
);

app.post(
  "/api/login",
  wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (loginBlocked(email)) {
      return res.status(429).json({ error: "Liiga palju katseid. Proovi mõne minuti pärast uuesti." });
    }
    const r = await query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [email]);
    const user = r.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      noteFailure(email);
      return res.status(401).json({ error: "Vale e-post või parool." });
    }
    failures.delete(email);
    res.json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name } });
  })
);

app.get(
  "/api/me",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query("SELECT id, email, name FROM users WHERE id = $1", [req.userId]);
    if (!r.rowCount) return res.status(401).json({ error: "Palun logi sisse." });
    res.json({ user: r.rows[0] });
  })
);

// --------------------------------------------------------------- bootstrap

// One call returns the whole till: settings, price list, products with their
// computed stock, invoices with lines, the cash book and every movement.
// A barbershop's yearly volume is small enough that paging would be pure
// ceremony — if this ever gets slow, page `invoices` first.
async function loadState(userId) {
  const [settings, services, products, stock, invoices, lines, ledger, moves] = await Promise.all([
    query("SELECT * FROM settings WHERE user_id = $1", [userId]),
    query("SELECT * FROM services WHERE user_id = $1 AND active ORDER BY sort_order, id", [userId]),
    query("SELECT * FROM products WHERE user_id = $1 AND active ORDER BY sort_order, id", [userId]),
    query(
      `SELECT product_id,
              SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END) AS qty
         FROM stock_movements WHERE user_id = $1 GROUP BY product_id`,
      [userId]
    ),
    query("SELECT * FROM invoices WHERE user_id = $1 ORDER BY invoice_date DESC, id DESC", [userId]),
    query(
      `SELECT l.* FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE i.user_id = $1 ORDER BY l.invoice_id, l.sort_order, l.id`,
      [userId]
    ),
    query("SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY entry_date, id", [userId]),
    query(
      `SELECT m.*, p.name AS product_name FROM stock_movements m
         JOIN products p ON p.id = m.product_id
        WHERE m.user_id = $1 ORDER BY m.move_date DESC, m.id DESC`,
      [userId]
    ),
  ]);

  const stockBy = new Map(stock.rows.map((r) => [r.product_id, Number(r.qty)]));
  const linesBy = new Map();
  for (const l of lines.rows) {
    if (!linesBy.has(l.invoice_id)) linesBy.set(l.invoice_id, []);
    linesBy.get(l.invoice_id).push(l);
  }

  return {
    settings: settings.rows[0] || null,
    services: services.rows,
    products: products.rows.map((p) => ({ ...p, stock: stockBy.get(p.id) || 0 })),
    invoices: invoices.rows.map((i) => ({ ...i, lines: linesBy.get(i.id) || [] })),
    ledger: ledger.rows,
    movements: moves.rows,
  };
}

app.get(
  "/api/bootstrap",
  requireAuth,
  wrap(async (req, res) => {
    res.json(await loadState(req.userId));
  })
);

// ---------------------------------------------------------------- settings

const SETTING_FIELDS = [
  "vat_rate", "show_vat", "ask_tip", "low_stock", "opening_balance", "payment_days",
  "company_name", "company_address", "company_reg", "company_kmkr",
  "company_bank", "company_iban", "company_email", "company_web",
];

app.put(
  "/api/settings",
  requireAuth,
  wrap(async (req, res) => {
    const sets = [];
    const vals = [req.userId];
    for (const f of SETTING_FIELDS) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (f === "show_vat" || f === "ask_tip") v = Boolean(v);
      else if (["vat_rate", "opening_balance"].includes(f)) v = num(v);
      else if (["low_stock", "payment_days"].includes(f)) v = Math.max(0, Math.round(num(v)));
      else v = String(v || "");
      vals.push(v);
      sets.push(f + " = $" + vals.length);
    }
    if (!sets.length) return res.status(400).json({ error: "Midagi ei muudetud." });
    const r = await query(
      "UPDATE settings SET " + sets.join(", ") + " WHERE user_id = $1 RETURNING *",
      vals
    );
    res.json({ settings: r.rows[0] });
  })
);

// ---------------------------------------------------- services and products

app.post(
  "/api/services",
  requireAuth,
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Teenuse nimi puudub." });
    const r = await query(
      `INSERT INTO services (user_id, name, price, note, sort_order)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order)+1,0) FROM services WHERE user_id=$1))
       RETURNING *`,
      [req.userId, name, num(req.body.price), String(req.body.note || "")]
    );
    res.status(201).json({ service: r.rows[0] });
  })
);

app.put(
  "/api/services/:id",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE services SET name = COALESCE($3, name), price = COALESCE($4, price), note = COALESCE($5, note)
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.userId,
        Number(req.params.id),
        req.body.name === undefined ? null : String(req.body.name),
        req.body.price === undefined ? null : num(req.body.price),
        req.body.note === undefined ? null : String(req.body.note),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    res.json({ service: r.rows[0] });
  })
);

app.delete(
  "/api/services/:id",
  requireAuth,
  wrap(async (req, res) => {
    // Soft delete: past invoices keep the name they were sold under.
    const r = await query("UPDATE services SET active = false WHERE id = $2 AND user_id = $1 RETURNING id", [
      req.userId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    res.json({ ok: true });
  })
);

app.post(
  "/api/products",
  requireAuth,
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Toote nimi puudub." });
    const r = await query(
      `INSERT INTO products (user_id, name, cost, price, sort_order)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order)+1,0) FROM products WHERE user_id=$1))
       RETURNING *`,
      [req.userId, name, num(req.body.cost), num(req.body.price)]
    );
    res.status(201).json({ product: { ...r.rows[0], stock: 0 } });
  })
);

app.put(
  "/api/products/:id",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE products SET name = COALESCE($3, name), cost = COALESCE($4, cost), price = COALESCE($5, price)
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.userId,
        Number(req.params.id),
        req.body.name === undefined ? null : String(req.body.name),
        req.body.cost === undefined ? null : num(req.body.cost),
        req.body.price === undefined ? null : num(req.body.price),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });
    res.json({ product: r.rows[0] });
  })
);

app.delete(
  "/api/products/:id",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query("UPDATE products SET active = false WHERE id = $2 AND user_id = $1 RETURNING id", [
      req.userId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });
    res.json({ ok: true });
  })
);

// -------------------------------------------------------------------- sale

// The one endpoint that matters. A sale writes an invoice, a cash-book entry
// and one stock movement per product line — inside a single transaction, so a
// failure halfway cannot leave the books disagreeing with the shelf.
app.post(
  "/api/sales",
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const date = isDate(body.date) ? body.date : today();
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (!rawLines.length) return res.status(400).json({ error: "Arvel pole ühtegi rida." });
    if (rawLines.length > 100) return res.status(400).json({ error: "Liiga palju ridu." });

    const lines = rawLines.map((l) => ({
      productId: l.productId ? Number(l.productId) : null,
      name: String(l.name || "").trim().slice(0, 200),
      qty: num(l.qty, 1),
      price: num(l.price, 0),
    }));
    for (const l of lines) {
      if (!l.name) return res.status(400).json({ error: "Real puudub nimi." });
      if (!(l.qty > 0)) return res.status(400).json({ error: "Vigane kogus real: " + l.name });
      if (l.price < 0) return res.status(400).json({ error: "Vigane hind real: " + l.name });
    }

    // Totals are recomputed here from the lines. The client's own total is
    // never trusted — it is a display value, not an input.
    const tip = Math.max(0, num(body.tip));
    const linesCents = lines.reduce((sum, l) => sum + Math.round(cents(l.price) * l.qty), 0);
    const totalCents = linesCents + cents(tip);
    const paidCents = cents(body.cash) + cents(body.card);
    if (paidCents !== totalCents) {
      return res.status(400).json({
        error:
          "Makse ei klapi: tasuda " +
          euros(totalCents).toFixed(2) +
          " €, sisestatud " +
          euros(paidCents).toFixed(2) +
          " €.",
      });
    }

    const result = await withTransaction(async (client) => {
      // Lock the settings row: this both serialises invoice numbering and
      // gives us the VAT rate that was in force at the moment of the sale.
      const s = await client.query("SELECT * FROM settings WHERE user_id = $1 FOR UPDATE", [req.userId]);
      const settings = s.rows[0];
      if (!settings) throw Object.assign(new Error("Seaded puuduvad."), { status: 400 });

      const year = Number(date.slice(0, 4));
      const seq = settings.invoice_year === year ? settings.invoice_seq + 1 : 1;
      await client.query("UPDATE settings SET invoice_year = $2, invoice_seq = $3 WHERE user_id = $1", [
        req.userId,
        year,
        seq,
      ]);
      const nr = year + "-" + String(seq).padStart(3, "0");

      // Stock is checked inside the transaction so two tills selling the last
      // jar at once cannot both succeed.
      for (const l of lines) {
        if (!l.productId) continue;
        const q = await client.query(
          `SELECT p.name,
                  COALESCE(SUM(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), 0) AS qty
             FROM products p
             LEFT JOIN stock_movements m ON m.product_id = p.id
            WHERE p.id = $2 AND p.user_id = $1
            GROUP BY p.name`,
          [req.userId, l.productId]
        );
        if (!q.rowCount) throw Object.assign(new Error("Toodet ei leitud."), { status: 400 });
        const have = Number(q.rows[0].qty);
        if (have < l.qty) {
          throw Object.assign(
            new Error(q.rows[0].name + " — laos on " + have + " tk, müüa proovid " + l.qty + " tk."),
            { status: 409 }
          );
        }
      }

      // Prices include VAT; the tip is outside the VAT base.
      const rate = Number(settings.vat_rate) || 0;
      const netCents = rate > 0 ? Math.round(linesCents / (1 + rate / 100)) : linesCents;
      const vatCents = linesCents - netCents;

      const inv = await client.query(
        `INSERT INTO invoices
           (user_id, nr, invoice_date, due_date, buyer_name, buyer_details,
            net, vat, vat_rate, tip, total, cash, card)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          req.userId,
          nr,
          date,
          addDays(date, settings.payment_days),
          String(body.buyerName || "Eraklient").slice(0, 200),
          String(body.buyerDetails || "Sularaha-/kaardimüük salongis").slice(0, 500),
          euros(netCents),
          euros(vatCents),
          rate,
          tip,
          euros(totalCents),
          euros(cents(body.cash)),
          euros(cents(body.card)),
        ]
      );
      const invoice = inv.rows[0];

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO invoice_lines (invoice_id, product_id, name, qty, unit, price, sort_order)
           VALUES ($1,$2,$3,$4,'tk',$5,$6)`,
          [invoice.id, l.productId, l.name, l.qty, l.price, i]
        );
        if (l.productId) {
          await client.query(
            `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price, invoice_id)
             VALUES ($1,$2,$3,'out',$4,$5,$6)`,
            [req.userId, l.productId, date, l.qty, l.price, invoice.id]
          );
        }
      }

      const hasProduct = lines.some((l) => l.productId);
      await client.query(
        `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card, invoice_id)
         VALUES ($1,$2,'tulu',$3,$4,$5,$6,$7)`,
        [
          req.userId,
          date,
          hasProduct ? "Kaubamüük" : "Teenuste müük",
          "Arve " + nr + " · " + invoice.buyer_name,
          invoice.cash,
          invoice.card,
          invoice.id,
        ]
      );

      return invoice;
    });

    res.status(201).json({ invoice: result, state: await loadState(req.userId) });
  })
);

// ------------------------------------------------------------- kassaraamat

const LEDGER_CATEGORIES = [
  "Teenuste müük", "Kaubamüük", "Kaubavaru", "Rent", "Töövahendid", "Palk", "Muu",
];

app.post(
  "/api/ledger",
  requireAuth,
  wrap(async (req, res) => {
    const date = isDate(req.body.date) ? req.body.date : today();
    const kind = req.body.kind === "tulu" ? "tulu" : "kulu";
    const category = LEDGER_CATEGORIES.includes(req.body.category) ? req.body.category : "Muu";
    const cash = Math.max(0, num(req.body.cash));
    const card = Math.max(0, num(req.body.card));
    if (cents(cash) + cents(card) === 0) {
      return res.status(400).json({ error: "Sisesta summa kas sularaha või kaardi lahtrisse." });
    }
    const r = await query(
      `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.userId, date, kind, category, String(req.body.description || "").slice(0, 300), cash, card]
    );
    res.status(201).json({ entry: r.rows[0] });
  })
);

app.delete(
  "/api/ledger/:id",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query("SELECT invoice_id FROM ledger_entries WHERE id = $2 AND user_id = $1", [
      req.userId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Kannet ei leitud." });
    if (r.rows[0].invoice_id) {
      return res.status(409).json({
        error: "See kanne kuulub arve juurde ja seda ei saa eraldi kustutada.",
      });
    }
    await query("DELETE FROM ledger_entries WHERE id = $2 AND user_id = $1", [
      req.userId,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);

// -------------------------------------------------------------------- ladu

app.post(
  "/api/stock-movements",
  requireAuth,
  wrap(async (req, res) => {
    const productId = Number(req.body.productId);
    const type = req.body.type === "out" ? "out" : "in";
    const qty = num(req.body.qty);
    const price = Math.max(0, num(req.body.price));
    const date = isDate(req.body.date) ? req.body.date : today();
    if (!(qty > 0)) return res.status(400).json({ error: "Kogus peab olema suurem kui null." });

    const owned = await query("SELECT id, name FROM products WHERE id = $2 AND user_id = $1", [
      req.userId,
      productId,
    ]);
    if (!owned.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });

    if (type === "out") {
      const q = await query(
        `SELECT COALESCE(SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END), 0) AS qty
           FROM stock_movements WHERE user_id = $1 AND product_id = $2`,
        [req.userId, productId]
      );
      const have = Number(q.rows[0].qty);
      if (have < qty) {
        return res.status(409).json({ error: "Laos on " + have + " tk, maha kanda proovid " + qty + " tk." });
      }
    }

    const r = await query(
      `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, productId, date, type, qty, price]
    );
    res.status(201).json({ movement: { ...r.rows[0], product_name: owned.rows[0].name } });
  })
);

app.delete(
  "/api/stock-movements/:id",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query("SELECT invoice_id FROM stock_movements WHERE id = $2 AND user_id = $1", [
      req.userId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Liikumist ei leitud." });
    if (r.rows[0].invoice_id) {
      return res.status(409).json({ error: "See liikumine tuli müügist ja seda ei saa eraldi kustutada." });
    }
    await query("DELETE FROM stock_movements WHERE id = $2 AND user_id = $1", [
      req.userId,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ static

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api", (req, res) => res.status(404).json({ error: "Tundmatu API otspunkt." }));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Errors thrown inside a route land here. `status` is set deliberately by the
// sale transaction for the cases the till should show verbatim.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Serveri viga. Proovi uuesti." : err.message });
});

app.listen(PORT, () => {
  console.log("Fi Barbershop server kuulab pordil " + PORT + " — http://localhost:" + PORT);
});
