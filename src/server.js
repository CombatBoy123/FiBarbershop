// server.js — Fi Barbershop back office.
// Serves public/ and a small JSON API. Everything is scoped to the logged-in
// user_id: two shops on the same instance never see each other's books.

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const { query, withTransaction, cents, euros } = require("./db");
const {
  ROLES, AREAS, cleanPermissions,
  hashPassword, verifyPassword, signToken, requireAuth, requireRole, requirePerm,
} = require("./auth");
const { seedDefaults } = require("./seed");

const app = express();
const PORT = process.env.PORT || 4100;

// Don't advertise the framework.
app.disable("x-powered-by");

// Behind Render/Cloudflare there is one proxy hop: trust it so req.ip is the
// real client (the login rate limiter relies on it) and req.secure reflects the
// TLS the browser actually used (the HSTS header below relies on it).
app.set("trust proxy", 1);

// Security headers on every response. Six headers are cheaper to read here than
// a helmet dependency; the till's stricter Content-Security-Policy is set on
// the /app route itself, because the saved storefront pages under public/site
// carry inline scripts and third-party assets a strict policy would break.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Only pin HTTPS over a genuinely secure connection, so local http testing is
  // never locked to https by a lingering HSTS entry.
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

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

// A barbershop price or cost is never negative and never approaches a million
// euros. Unlike num(), which silently turns junk into 0, this rejects bad input
// so a typo or a tampered request becomes a 400 instead of a -100 € product.
const MAX_MONEY = 1000000;
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
    throw Object.assign(new Error("Vigane summa. Lubatud on 0–" + MAX_MONEY + " €."), { status: 400 });
  }
  return n;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Wraps an async route so a rejected promise becomes a handled error response
// instead of an unhandled rejection that silently kills the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Owner-only, and not switchable. Everything here either moves money that has
// already been booked or hands out access — cancelling, deleting and paying
// invoices, creating accounts, changing roles and permissions, resetting
// someone else's password. Making these grantable would let an account the
// owner meant to limit quietly promote itself.
const ownerOnly = [requireAuth, requireRole("omanik")];

// Gated by a switch the owner can flip per account, under Kontod. An owner
// always passes; a barber passes only when that area is on for them.
const areaOnly = (area) => [requireAuth, requirePerm(area)];

// ------------------------------------------------------------ invoice lines

const UNITS = ["tk", "h", "kord", "km", "päev"];

// One line as the server will store it. Every field is taken from the request
// and written onto the invoice as a copy — the price list is read to offer a
// price, never to decide one. That is what lets a barber charge 40 € on one
// invoice without moving the 35 € everyone else pays.
function normaliseLines(raw) {
  const rawLines = Array.isArray(raw) ? raw : [];
  if (!rawLines.length) throw Object.assign(new Error("Arvel pole ühtegi rida."), { status: 400 });
  if (rawLines.length > 100) throw Object.assign(new Error("Liiga palju ridu."), { status: 400 });

  return rawLines.map((l) => {
    const line = {
      productId: l.productId ? Number(l.productId) : null,
      serviceId: l.serviceId ? Number(l.serviceId) : null,
      name: String(l.name || "").trim().slice(0, 200),
      note: String(l.note || "").trim().slice(0, 300),
      unit: UNITS.includes(String(l.unit)) ? String(l.unit) : "tk",
      qty: num(l.qty, 1),
      price: num(l.price, 0),
      discount: num(l.discount, 0),
    };
    if (!line.name) throw Object.assign(new Error("Real puudub nimi."), { status: 400 });
    if (!(line.qty > 0) || line.qty > 100000) {
      throw Object.assign(new Error("Vigane kogus real: " + line.name), { status: 400 });
    }
    if (line.price < 0 || line.price > MAX_MONEY) {
      throw Object.assign(new Error("Vigane hind real: " + line.name), { status: 400 });
    }
    if (line.discount < 0 || line.discount > 100) {
      throw Object.assign(new Error("Allahindlus peab olema 0–100% real: " + line.name), { status: 400 });
    }
    return line;
  });
}

// `price` stays the undiscounted unit price so the invoice can print both the
// list price and the reduction. The discount belongs in this one formula and
// nowhere else — a discount added as a negative line would corrupt the VAT base.
const lineCents = (l) => Math.round(cents(l.price) * l.qty * (1 - l.discount / 100));
const linesTotalCents = (lines) => lines.reduce((sum, l) => sum + lineCents(l), 0);

// Writes the lines of one invoice, and books a stock movement for every line
// that came off a shelf. Shared by the till and by issuing a composed invoice.
async function writeLines(client, shopId, invoiceId, lines, date) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await client.query(
      `INSERT INTO invoice_lines
         (invoice_id, product_id, service_id, name, note, qty, unit, price, discount, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [invoiceId, l.productId, l.serviceId, l.name, l.note, l.qty, l.unit, l.price, l.discount, i]
    );
    if (l.productId) {
      await client.query(
        `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price, invoice_id)
         VALUES ($1,$2,$3,'out',$4,$5,$6)`,
        [shopId, l.productId, date, l.qty, l.price, invoiceId]
      );
    }
  }
}

// Stock is checked inside the caller's transaction so two tills selling the
// last jar at once cannot both succeed.
async function assertStock(client, shopId, lines) {
  for (const l of lines) {
    if (!l.productId) continue;
    const q = await client.query(
      `SELECT p.name,
              COALESCE(SUM(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), 0) AS qty
         FROM products p
         LEFT JOIN stock_movements m ON m.product_id = p.id
        WHERE p.id = $2 AND p.user_id = $1
        GROUP BY p.name`,
      [shopId, l.productId]
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
}

// Mints the next invoice number under the settings row lock, so two tills can
// never hand out the same one. Format is MMYY-NNN and the counter restarts
// monthly: a daily reset would mint 0826-001 twice in August.
// The caller must already hold `settings` FOR UPDATE.
async function allocateNumber(client, shopId, settings, date) {
  const month = date.slice(0, 7);
  const seq = String(settings.invoice_month || "") === month ? settings.invoice_seq + 1 : 1;
  await client.query(
    "UPDATE settings SET invoice_month = $2, invoice_seq = $3, invoice_year = $4 WHERE user_id = $1",
    [shopId, month, seq, Number(date.slice(0, 4))]
  );
  const [yyyy, mm] = date.split("-");
  return mm + yyyy.slice(2) + "-" + String(seq).padStart(3, "0");
}

// The cash-book entry an invoice produces when the money actually arrives.
// For the till that is the moment of sale; for a credit invoice it is weeks
// later, which is exactly why this is a function and not an inline INSERT.
async function bookIncome(client, shopId, invoice, lines) {
  const hasProduct = lines.some((l) => l.product_id || l.productId);
  await client.query(
    `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card, bank, invoice_id)
     VALUES ($1,$2,'tulu',$3,$4,$5,$6,$7,$8)`,
    [
      shopId,
      String(invoice.paid_date || invoice.invoice_date).slice(0, 10),
      hasProduct ? "Kaubamüük" : "Teenuste müük",
      "Arve " + invoice.nr + " · " + invoice.buyer_name,
      invoice.cash,
      invoice.card,
      invoice.bank || 0,
      invoice.id,
    ]
  );
}

// Every irreversible act leaves a row here. Small table, but it is the only
// thing that can answer "who cancelled 0926-004, and why".
async function audit(client, shopId, actorId, action, invoiceId, detail) {
  await client.query(
    `INSERT INTO audit_log (shop_id, actor_id, action, invoice_id, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [shopId, actorId, action, invoiceId || null, String(detail || "").slice(0, 300)]
  );
}

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

// Per-IP guard, complementing the per-email lockout above. The email lock stops
// hammering one account; this stops password-spraying (many emails, a few tries
// each) from a single source. The window is deliberately generous — a real shop
// logs in a handful of times a day, so 40 login POSTs in 10 minutes from one IP
// is already far past normal use and well short of anything brute-force needs.
const ipHits = new Map();
const IP_MAX = 40;
const IP_WINDOW_MS = 10 * 60 * 1000;

function ipLoginBlocked(ip) {
  const rec = ipHits.get(ip);
  if (!rec || Date.now() - rec.at > IP_WINDOW_MS) return false;
  return rec.n >= IP_MAX;
}

function noteIpLogin(ip) {
  const rec = ipHits.get(ip);
  if (!rec || Date.now() - rec.at > IP_WINDOW_MS) ipHits.set(ip, { n: 1, at: Date.now() });
  else rec.n += 1;
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
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1,$2,$3,'omanik') RETURNING id, email, name, role`,
        [email, await hashPassword(password), name || null]
      );
      // Registering creates a shop, so the account is its own shop. A barber
      // is never created here — the owner adds those under /api/staff.
      await client.query("UPDATE users SET shop_id = id WHERE id = $1", [r.rows[0].id]);
      await seedDefaults(client, r.rows[0].id);
      return r.rows[0];
    });

    res.status(201).json({ token: signToken(user), user });
  })
);

app.post(
  "/api/login",
  wrap(async (req, res) => {
    const ip = req.ip || "?";
    if (ipLoginBlocked(ip)) {
      return res.status(429).json({ error: "Liiga palju katseid. Proovi mõne minuti pärast uuesti." });
    }
    noteIpLogin(ip);

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (loginBlocked(email)) {
      return res.status(429).json({ error: "Liiga palju katseid. Proovi mõne minuti pärast uuesti." });
    }
    const r = await query(
      "SELECT id, email, name, password_hash, role, active FROM users WHERE email = $1",
      [email]
    );
    const user = r.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      noteFailure(email);
      return res.status(401).json({ error: "Vale e-post või parool." });
    }
    // A closed account fails here rather than at the first API call, so the
    // person is told why instead of watching an empty till load.
    if (!user.active) {
      return res.status(403).json({ error: "See konto on suletud. Võta ühendust salongi omanikuga." });
    }
    failures.delete(email);
    res.json({
      token: signToken(user),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  })
);

app.get(
  "/api/me",
  requireAuth,
  wrap(async (req, res) => {
    const r = await query("SELECT id, email, name, role FROM users WHERE id = $1", [req.userId]);
    if (!r.rowCount) return res.status(401).json({ error: "Palun logi sisse." });
    res.json({ user: r.rows[0] });
  })
);

// --------------------------------------------------------------- bootstrap

// One call returns the whole till: settings, price list, products with their
// computed stock, invoices with lines, the cash book and every movement.
// A barbershop's yearly volume is small enough that paging would be pure
// ceremony — if this ever gets slow, page `invoices` first.
async function loadState(shopId) {
  const [
    settings, services, products, stock, invoices, lines, ledger, moves,
    staff, customers, custPrices, barbers, barberPrices, auditRows,
  ] = await Promise.all([
    query("SELECT * FROM settings WHERE user_id = $1", [shopId]),
    query("SELECT * FROM services WHERE user_id = $1 AND active ORDER BY sort_order, id", [shopId]),
    query("SELECT * FROM products WHERE user_id = $1 AND active ORDER BY sort_order, id", [shopId]),
    query(
      `SELECT product_id,
              SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END) AS qty
         FROM stock_movements WHERE user_id = $1 GROUP BY product_id`,
      [shopId]
    ),
    // Drafts have no date-ordered place in the sequence yet, so they sort to
    // the top by id — they are the thing being worked on right now.
    query(
      `SELECT i.*, u.name AS created_by_name, u.email AS created_by_email
         FROM invoices i
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.user_id = $1
        ORDER BY (i.status = 'mustand') DESC, i.invoice_date DESC, i.id DESC`,
      [shopId]
    ),
    query(
      `SELECT l.* FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE i.user_id = $1 ORDER BY l.invoice_id, l.sort_order, l.id`,
      [shopId]
    ),
    query("SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY entry_date, id", [shopId]),
    query(
      `SELECT m.*, p.name AS product_name FROM stock_movements m
         JOIN products p ON p.id = m.product_id
        WHERE m.user_id = $1 ORDER BY m.move_date DESC, m.id DESC`,
      [shopId]
    ),
    query(
      `SELECT id, email, name, role, active, permissions, created_at FROM users
        WHERE shop_id = $1 ORDER BY (role = 'omanik') DESC, name, email`,
      [shopId]
    ),
    query(
      "SELECT * FROM customers WHERE user_id = $1 AND active ORDER BY name",
      [shopId]
    ),
    query(
      `SELECT cp.* FROM customer_prices cp
         JOIN customers c ON c.id = cp.customer_id
        WHERE c.user_id = $1`,
      [shopId]
    ),
    query(
      `SELECT b.*, u.email AS account_email FROM barbers b
         LEFT JOIN users u ON u.id = b.account_id
        WHERE b.user_id = $1 AND b.active ORDER BY b.sort_order, b.id`,
      [shopId]
    ),
    query(
      `SELECT bp.* FROM barber_prices bp
         JOIN barbers b ON b.id = bp.barber_id
        WHERE b.user_id = $1`,
      [shopId]
    ),
    query(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email, i.nr AS invoice_nr
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN invoices i ON i.id = a.invoice_id
        WHERE a.shop_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
      [shopId]
    ),
  ]);

  const stockBy = new Map(stock.rows.map((r) => [r.product_id, Number(r.qty)]));
  const linesBy = new Map();
  for (const l of lines.rows) {
    if (!linesBy.has(l.invoice_id)) linesBy.set(l.invoice_id, []);
    linesBy.get(l.invoice_id).push(l);
  }
  const pricesBy = new Map();
  for (const p of custPrices.rows) {
    if (!pricesBy.has(p.customer_id)) pricesBy.set(p.customer_id, {});
    pricesBy.get(p.customer_id)[p.service_id] = Number(p.price);
  }
  const barberPriceBy = new Map();
  for (const p of barberPrices.rows) {
    if (!barberPriceBy.has(p.barber_id)) barberPriceBy.set(p.barber_id, {});
    barberPriceBy.get(p.barber_id)[p.service_id] = {
      price: Number(p.price),
      offered: p.offered,
    };
  }

  return {
    settings: settings.rows[0] || null,
    services: services.rows,
    products: products.rows.map((p) => ({ ...p, stock: stockBy.get(p.id) || 0 })),
    invoices: invoices.rows.map((i) => ({ ...i, lines: linesBy.get(i.id) || [] })),
    ledger: ledger.rows,
    movements: moves.rows,
    staff: staff.rows,
    customers: customers.rows.map((c) => ({ ...c, prices: pricesBy.get(c.id) || {} })),
    barbers: barbers.rows.map((b) => ({ ...b, prices: barberPriceBy.get(b.id) || {} })),
    audit: auditRows.rows,
  };
}

app.get(
  "/api/bootstrap",
  requireAuth,
  wrap(async (req, res) => {
    const state = await loadState(req.shopId);
    // The client needs to know which tabs and buttons to draw. It is not the
    // security boundary — every gated route checks again server-side. `can` is
    // sent already resolved so the client never has to reimplement the
    // role-and-default rules and drift out of step with them.
    state.me = {
      id: req.userId,
      email: req.userEmail,
      name: req.userName,
      role: req.role,
      permissions: req.permissions,
      can: AREAS.reduce((acc, area) => Object.assign(acc, { [area]: req.can(area) }), {}),
    };
    res.json(state);
  })
);

// ---------------------------------------------------------------- settings

const SETTING_FIELDS = [
  "vat_rate", "show_vat", "ask_tip", "low_stock", "opening_balance", "payment_days",
  "company_name", "company_address", "company_reg", "company_kmkr",
  "company_bank", "company_iban", "company_phone", "company_email", "company_web",
];

app.put(
  "/api/settings",
  areaOnly("price"),
  wrap(async (req, res) => {
    const sets = [];
    const vals = [req.shopId];
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
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Teenuse nimi puudub." });
    const r = await query(
      `INSERT INTO services (user_id, name, price, note, sort_order)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order)+1,0) FROM services WHERE user_id=$1))
       RETURNING *`,
      [req.shopId, name, money(req.body.price), String(req.body.note || "")]
    );
    res.status(201).json({ service: r.rows[0] });
  })
);

app.put(
  "/api/services/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE services SET name = COALESCE($3, name), price = COALESCE($4, price), note = COALESCE($5, note)
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.shopId,
        Number(req.params.id),
        req.body.name === undefined ? null : String(req.body.name),
        req.body.price === undefined ? null : money(req.body.price),
        req.body.note === undefined ? null : String(req.body.note),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    res.json({ service: r.rows[0] });
  })
);

app.delete(
  "/api/services/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    // Soft delete: past invoices keep the name they were sold under.
    const r = await query("UPDATE services SET active = false WHERE id = $2 AND user_id = $1 RETURNING id", [
      req.shopId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    res.json({ ok: true });
  })
);

app.post(
  "/api/products",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Toote nimi puudub." });
    const r = await query(
      `INSERT INTO products (user_id, name, cost, price, image_url, sort_order)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort_order)+1,0) FROM products WHERE user_id=$1))
       RETURNING *`,
      [req.shopId, name, money(req.body.cost), money(req.body.price), String(req.body.image_url || "")]
    );
    res.status(201).json({ product: { ...r.rows[0], stock: 0 } });
  })
);

app.put(
  "/api/products/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE products SET name = COALESCE($3, name), cost = COALESCE($4, cost),
              price = COALESCE($5, price), image_url = COALESCE($6, image_url)
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.shopId,
        Number(req.params.id),
        req.body.name === undefined ? null : String(req.body.name),
        req.body.cost === undefined ? null : money(req.body.cost),
        req.body.price === undefined ? null : money(req.body.price),
        req.body.image_url === undefined ? null : String(req.body.image_url),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });
    res.json({ product: r.rows[0] });
  })
);

// Set the stock of one product outright (a stocktake). Stock is derived from
// movements, never stored, so this does not overwrite a number — it books the
// difference as one correcting movement and leaves the history intact.
app.put(
  "/api/products/:id/stock",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const productId = Number(req.params.id);
    const target = num(req.body.qty, -1);
    if (!(target >= 0)) return res.status(400).json({ error: "Kogus ei saa olla negatiivne." });
    const date = isDate(req.body.date) ? req.body.date : today();

    const delta = await withTransaction(async (client) => {
      // Locking the product serialises two tills correcting the same item.
      const p = await client.query(
        "SELECT id, cost FROM products WHERE id = $2 AND user_id = $1 FOR UPDATE",
        [req.shopId, productId]
      );
      if (!p.rowCount) throw Object.assign(new Error("Toodet ei leitud."), { status: 404 });

      const cur = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END), 0) AS qty
           FROM stock_movements WHERE user_id = $1 AND product_id = $2`,
        [req.shopId, productId]
      );
      const diff = target - Number(cur.rows[0].qty);
      if (diff === 0) return 0;

      await client.query(
        `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.shopId, productId, date, diff > 0 ? "in" : "out", Math.abs(diff), Number(p.rows[0].cost) || 0]
      );
      return diff;
    });

    res.json({ delta, state: await loadState(req.shopId) });
  })
);

app.delete(
  "/api/products/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const r = await query("UPDATE products SET active = false WHERE id = $2 AND user_id = $1 RETURNING id", [
      req.shopId,
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
    const lines = normaliseLines(body.lines);

    // Optional: the till fills these in only when the invoice has to be made
    // out to a named person or company.
    const buyerName = String(body.buyerName || "").trim().slice(0, 200);
    const buyerDetails = String(body.buyerDetails || "").trim().slice(0, 500);
    const customerId = body.customerId ? Number(body.customerId) : null;

    // Totals are recomputed here from the lines. The client's own total is
    // never trusted — it is a display value, not an input.
    const tip = Math.max(0, num(body.tip));
    const linesCents = linesTotalCents(lines);
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
      const s = await client.query("SELECT * FROM settings WHERE user_id = $1 FOR UPDATE", [req.shopId]);
      const settings = s.rows[0];
      if (!settings) throw Object.assign(new Error("Seaded puuduvad."), { status: 400 });

      const nr = await allocateNumber(client, req.shopId, settings, date);
      await assertStock(client, req.shopId, lines);

      // Prices include VAT; the tip is outside the VAT base.
      const rate = Number(settings.vat_rate) || 0;
      const netCents = rate > 0 ? Math.round(linesCents / (1 + rate / 100)) : linesCents;
      const vatCents = linesCents - netCents;

      const inv = await client.query(
        `INSERT INTO invoices
           (user_id, nr, invoice_date, due_date, buyer_name, buyer_details, customer_id,
            net, vat, vat_rate, tip, total, cash, card, status, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'makstud',now(),$15) RETURNING *`,
        [
          req.shopId,
          nr,
          date,
          addDays(date, settings.payment_days),
          buyerName || "Eraklient",
          // The walk-in note only fits a sale with no named buyer. Once the
          // till has been given a name, an empty details line stays empty
          // rather than telling a company how its own invoice was paid.
          buyerDetails || (buyerName ? "" : "Sularaha-/kaardimüük salongis"),
          customerId,
          euros(netCents),
          euros(vatCents),
          rate,
          tip,
          euros(totalCents),
          euros(cents(body.cash)),
          euros(cents(body.card)),
          req.userId,
        ]
      );
      const invoice = inv.rows[0];

      await writeLines(client, req.shopId, invoice.id, lines, date);
      await bookIncome(client, req.shopId, invoice, lines);

      return invoice;
    });

    res.status(201).json({ invoice: result, state: await loadState(req.shopId) });
  })
);

// ------------------------------------------------------- composed invoices

// The till above is one flow: everything happens at once and the money is
// already in the drawer. This is the other flow — an invoice put together over
// a week and paid later by transfer. Same tables, same numbering, separate
// endpoints, so nothing here can slow down or break the till.

// Recompute an invoice's stored totals from its own lines. Kept as a function
// because a draft is edited repeatedly and every edit has to leave the header
// figures agreeing with the rows underneath.
async function retotal(client, shopId, invoiceId, lines, tip) {
  const s = await client.query("SELECT vat_rate FROM settings WHERE user_id = $1", [shopId]);
  const rate = Number(s.rows[0] && s.rows[0].vat_rate) || 0;
  const linesCents = linesTotalCents(lines);
  const totalCents = linesCents + cents(tip);
  const netCents = rate > 0 ? Math.round(linesCents / (1 + rate / 100)) : linesCents;
  return {
    rate,
    net: euros(netCents),
    vat: euros(linesCents - netCents),
    total: euros(totalCents),
    totalCents,
  };
}

// Fetch one invoice belonging to this shop, or throw. Every route below starts
// here, which is what keeps one shop out of another's books.
async function getInvoice(client, shopId, id, forUpdate = false) {
  const r = await client.query(
    "SELECT * FROM invoices WHERE id = $2 AND user_id = $1" + (forUpdate ? " FOR UPDATE" : ""),
    [shopId, id]
  );
  if (!r.rowCount) throw Object.assign(new Error("Arvet ei leitud."), { status: 404 });
  return r.rows[0];
}

// Create a draft. No number is minted and no stock moves: a draft is not yet
// a document, which is precisely why deleting one is harmless.
app.post(
  "/api/invoices",
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const date = isDate(body.date) ? body.date : today();
    const lines = normaliseLines(body.lines);
    const tip = Math.max(0, num(body.tip));

    const invoice = await withTransaction(async (client) => {
      const s = await client.query("SELECT payment_days FROM settings WHERE user_id = $1", [req.shopId]);
      const days = Number(s.rows[0] && s.rows[0].payment_days) || 14;
      const t = await retotal(client, req.shopId, null, lines, tip);

      const inv = await client.query(
        `INSERT INTO invoices
           (user_id, nr, invoice_date, due_date, buyer_name, buyer_details, customer_id,
            net, vat, vat_rate, tip, total, status, created_by)
         VALUES ($1,'',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'mustand',$12) RETURNING *`,
        [
          req.shopId,
          date,
          addDays(date, days),
          String(body.buyerName || "").trim().slice(0, 200) || "Eraklient",
          String(body.buyerDetails || "").trim().slice(0, 500),
          body.customerId ? Number(body.customerId) : null,
          t.net, t.vat, t.rate, tip, t.total,
          req.userId,
        ]
      );
      await writeLines(client, req.shopId, inv.rows[0].id, lines, date);
      return inv.rows[0];
    });

    res.status(201).json({ invoice, state: await loadState(req.shopId) });
  })
);

// Replace a draft's contents. Only a draft: once a number is on a document it
// is no longer ours to rewrite.
app.put(
  "/api/invoices/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const lines = normaliseLines(body.lines);
    const tip = Math.max(0, num(body.tip));

    const invoice = await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, id, true);
      if (cur.status !== "mustand") {
        throw Object.assign(
          new Error("Ainult mustandit saab muuta. Esitatud arve tuleb tühistada ja uus koostada."),
          { status: 409 }
        );
      }
      const date = isDate(body.date) ? body.date : String(cur.invoice_date).slice(0, 10);
      const t = await retotal(client, req.shopId, id, lines, tip);

      await client.query("DELETE FROM invoice_lines WHERE invoice_id = $1", [id]);
      await writeLines(client, req.shopId, id, lines, date);

      const r = await client.query(
        `UPDATE invoices SET invoice_date = $3, buyer_name = $4, buyer_details = $5,
                customer_id = $6, net = $7, vat = $8, vat_rate = $9, tip = $10, total = $11
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [
          req.shopId, id, date,
          String(body.buyerName || "").trim().slice(0, 200) || "Eraklient",
          String(body.buyerDetails || "").trim().slice(0, 500),
          body.customerId ? Number(body.customerId) : null,
          t.net, t.vat, t.rate, tip, t.total,
        ]
      );
      return r.rows[0];
    });

    res.json({ invoice, state: await loadState(req.shopId) });
  })
);

// Issue a draft: this is the moment it becomes a document. The number is
// minted, the goods leave the shelf, and either the money is taken now or the
// invoice goes out on credit with a due date.
app.post(
  "/api/invoices/:id/issue",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const payNow = body.payNow !== false;

    const invoice = await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, id, true);
      if (cur.status !== "mustand") {
        throw Object.assign(new Error("See arve on juba esitatud."), { status: 409 });
      }

      const lr = await client.query(
        "SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, id",
        [id]
      );
      if (!lr.rowCount) throw Object.assign(new Error("Arvel pole ühtegi rida."), { status: 400 });
      const lines = lr.rows.map((l) => ({
        productId: l.product_id,
        qty: Number(l.qty),
        price: Number(l.price),
        discount: Number(l.discount),
      }));

      // An invoice is dated the day it is issued, not the day the draft was
      // started — otherwise a draft opened on Monday and issued on Friday
      // would carry Monday's date and, worse, Monday's month in its number.
      const date = isDate(body.date) ? body.date : today();
      const totalCents = cents(cur.total);

      // Paying now must balance exactly, same rule as the till. Paying later
      // means nothing is entered — and, crucially, no cash-book entry is
      // written, because no money has arrived.
      let cash = 0, card = 0, bank = 0;
      if (payNow) {
        cash = Math.max(0, num(body.cash));
        card = Math.max(0, num(body.card));
        if (cents(cash) + cents(card) !== totalCents) {
          throw Object.assign(
            new Error(
              "Makse ei klapi: tasuda " + euros(totalCents).toFixed(2) +
              " €, sisestatud " + euros(cents(cash) + cents(card)).toFixed(2) + " €."
            ),
            { status: 400 }
          );
        }
      }

      const s = await client.query("SELECT * FROM settings WHERE user_id = $1 FOR UPDATE", [req.shopId]);
      const settings = s.rows[0];
      if (!settings) throw Object.assign(new Error("Seaded puuduvad."), { status: 400 });

      const nr = await allocateNumber(client, req.shopId, settings, date);
      await assertStock(client, req.shopId, lines);

      // The goods leave the shelf now, not when the draft was written.
      for (const l of lines) {
        if (!l.productId) continue;
        await client.query(
          `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price, invoice_id)
           VALUES ($1,$2,$3,'out',$4,$5,$6)`,
          [req.shopId, l.productId, date, l.qty, l.price, id]
        );
      }

      const r = await client.query(
        `UPDATE invoices SET nr = $3, status = $4, cash = $5, card = $6, bank = $7,
                invoice_date = $8, due_date = $9,
                paid_at = CASE WHEN $4 = 'makstud' THEN now() ELSE NULL END
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [
          req.shopId, id, nr, payNow ? "makstud" : "esitatud", cash, card, bank,
          date, addDays(date, Number(settings.payment_days) || 14),
        ]
      );
      const inv = r.rows[0];

      if (payNow) await bookIncome(client, req.shopId, inv, lr.rows);
      await audit(client, req.shopId, req.userId, payNow ? "arve esitatud ja makstud" : "arve esitatud", id, nr);
      return inv;
    });

    res.json({ invoice, state: await loadState(req.shopId) });
  })
);

// The money arrived. This is where a credit invoice finally reaches the cash
// book — weeks after it was issued, which is the whole reason the cash-book
// entry is not written at issue time.
app.post(
  "/api/invoices/:id/pay",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const paidDate = isDate(body.date) ? body.date : today();

    const invoice = await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, id, true);
      if (cur.status === "tühistatud") {
        throw Object.assign(new Error("Tühistatud arvet ei saa makstuks märkida."), { status: 409 });
      }
      if (cur.status === "mustand") {
        throw Object.assign(new Error("Mustand tuleb enne esitada."), { status: 409 });
      }
      if (cur.status === "makstud") {
        throw Object.assign(new Error("See arve on juba makstud."), { status: 409 });
      }

      const totalCents = cents(cur.total);
      const cash = Math.max(0, num(body.cash));
      const card = Math.max(0, num(body.card));
      // Default: the whole sum came in by transfer, which is what a credit
      // invoice normally means.
      const bank = body.bank === undefined ? euros(totalCents - cents(cash) - cents(card)) : Math.max(0, num(body.bank));
      if (cents(cash) + cents(card) + cents(bank) !== totalCents) {
        throw Object.assign(
          new Error("Makse ei klapi: tasuda " + euros(totalCents).toFixed(2) + " €."),
          { status: 400 }
        );
      }

      const r = await client.query(
        `UPDATE invoices SET status = 'makstud', paid_at = now(), cash = $3, card = $4, bank = $5
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [req.shopId, id, cash, card, bank]
      );
      const inv = r.rows[0];

      const lr = await client.query("SELECT * FROM invoice_lines WHERE invoice_id = $1", [id]);
      await bookIncome(client, req.shopId, { ...inv, paid_date: paidDate }, lr.rows);
      await audit(client, req.shopId, req.userId, "arve makstud", id, inv.nr);
      return inv;
    });

    res.json({ invoice, state: await loadState(req.shopId) });
  })
);

// Delete a DRAFT. Not a document, no number, nothing booked — so anyone may
// throw one away and nothing in the accounts notices. An issued invoice is
// refused here on purpose: that is what cancelling is for.
app.delete(
  "/api/invoices/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, id, true);
      if (cur.status !== "mustand") {
        throw Object.assign(
          new Error("Esitatud arvet ei saa kustutada — number peab numbrireas alles jääma. Kasuta tühistamist."),
          { status: 409 }
        );
      }
      await client.query("DELETE FROM invoices WHERE id = $2 AND user_id = $1", [req.shopId, id]);
    });
    res.json({ ok: true, state: await loadState(req.shopId) });
  })
);

// Cancel an invoice that should never have been issued. The number is kept
// and the row stays visible as TÜHISTATUD: deleting it would leave a hole in
// the sequence that cannot be explained to an accountant later.
//
// The cash-book entry and the stock movements it created are removed, because
// no money changed hands and no goods left the shelf. The audit trail for the
// cancellation itself lives on the invoice.
app.post(
  "/api/invoices/:id/cancel",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    // The reason is required, not optional. The old prompt() defaulted to an
    // empty string, so one stray Enter voided an invoice and left nothing
    // behind to explain it.
    const reason = String(req.body.reason || "").trim().slice(0, 300);
    if (!reason) {
      return res.status(400).json({ error: "Tühistamiseks on põhjus kohustuslik." });
    }

    await withTransaction(async (client) => {
      const inv = await getInvoice(client, req.shopId, id, true);
      if (inv.status === "mustand") {
        throw Object.assign(
          new Error("Mustandit ei tühistata — selle saab lihtsalt kustutada."),
          { status: 409 }
        );
      }
      if (inv.cancelled_at) {
        throw Object.assign(new Error("See arve on juba tühistatud."), { status: 409 });
      }

      // paid_at is deliberately left in place: it is the only record of what
      // this invoice was before it was voided, and uncancelling reads it.
      await client.query("DELETE FROM ledger_entries WHERE user_id = $1 AND invoice_id = $2", [req.shopId, id]);
      await client.query("DELETE FROM stock_movements WHERE user_id = $1 AND invoice_id = $2", [req.shopId, id]);
      await client.query(
        `UPDATE invoices SET cancelled_at = now(), cancel_reason = $3, status = 'tühistatud'
          WHERE id = $2 AND user_id = $1`,
        [req.shopId, id, reason]
      );
      await audit(client, req.shopId, req.userId, "arve tühistatud", id, inv.nr + " · " + reason);
    });

    res.json({ state: await loadState(req.shopId) });
  })
);

// Undo a cancellation made by mistake, within a day of making it. Everything
// needed to rebuild the cash-book entry and the stock movements is still on
// the invoice and its lines, so this restores rather than re-creates.
const UNCANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

app.post(
  "/api/invoices/:id/uncancel",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);

    const invoice = await withTransaction(async (client) => {
      const inv = await getInvoice(client, req.shopId, id, true);
      if (!inv.cancelled_at) {
        throw Object.assign(new Error("See arve ei ole tühistatud."), { status: 409 });
      }
      if (Date.now() - new Date(inv.cancelled_at).getTime() > UNCANCEL_WINDOW_MS) {
        throw Object.assign(
          new Error("Tühistamise saab tagasi võtta 24 tunni jooksul. Koosta uus arve."),
          { status: 409 }
        );
      }

      const lr = await client.query(
        "SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, id",
        [id]
      );
      const lines = lr.rows.map((l) => ({
        productId: l.product_id,
        qty: Number(l.qty),
        price: Number(l.price),
        discount: Number(l.discount),
      }));
      await assertStock(client, req.shopId, lines);

      const date = String(inv.invoice_date).slice(0, 10);
      for (const l of lines) {
        if (!l.productId) continue;
        await client.query(
          `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price, invoice_id)
           VALUES ($1,$2,$3,'out',$4,$5,$6)`,
          [req.shopId, l.productId, date, l.qty, l.price, id]
        );
      }

      // paid_at survived the cancellation, so it says what this invoice was.
      const wasPaid = Boolean(inv.paid_at);
      const r = await client.query(
        `UPDATE invoices SET cancelled_at = NULL, cancel_reason = '', status = $3
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [req.shopId, id, wasPaid ? "makstud" : "esitatud"]
      );
      if (wasPaid) await bookIncome(client, req.shopId, r.rows[0], lr.rows);
      await audit(client, req.shopId, req.userId, "tühistamine tagasi võetud", id, inv.nr);
      return r.rows[0];
    });

    res.json({ invoice, state: await loadState(req.shopId) });
  })
);

// Remove an invoice from the books entirely. Owner only.
//
// The shop asked for a real delete and this is it: any invoice, whatever its
// number and whether or not it was cancelled first. The trade-off is stated
// plainly rather than engineered away — deleting anything but the month's last
// invoice leaves a gap in the numbering, and a gap is something the shop has
// to be able to explain. What this endpoint does guarantee is that the books
// never end up disagreeing with themselves:
//
//   * the cash-book entry and the stock movements go with it, so takings and
//     the shelf stay right even when the invoice was never cancelled;
//   * the counter is wound back when the invoice happens to be the month's
//     last, so that number is reissued instead of being skipped as well;
//   * an audit row survives the invoice, carrying the number, the buyer and
//     the amount — after this, that row is the only record the invoice existed.
app.delete(
  "/api/invoices/:id/permanent",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);

    const removed = await withTransaction(async (client) => {
      const s = await client.query("SELECT * FROM settings WHERE user_id = $1 FOR UPDATE", [req.shopId]);
      const settings = s.rows[0];
      const inv = await getInvoice(client, req.shopId, id, true);

      if (inv.status === "mustand") {
        throw Object.assign(new Error("Mustandi kustutamiseks kasuta tavalist kustutamist."), { status: 409 });
      }

      // Same month = same MMYY prefix, and the counter is zero-padded, so the
      // highest sequence under that prefix is the month's last invoice.
      const prefix = String(inv.nr).split("-")[0];
      const seqOf = (nr) => Number(String(nr).split("-")[1]) || 0;
      const mine = seqOf(inv.nr);
      const others = await client.query(
        "SELECT nr FROM invoices WHERE user_id = $1 AND nr LIKE $2 AND nr <> '' AND id <> $3",
        [req.shopId, prefix + "-%", id]
      );
      const highest = others.rows.reduce((m, r) => Math.max(m, seqOf(r.nr)), 0);
      const leavesGap = mine < highest;

      await audit(
        client, req.shopId, req.userId, "arve kustutatud jäädavalt", null,
        inv.nr + " · " + inv.buyer_name + " · " + Number(inv.total).toFixed(2) + " € · " +
          String(inv.invoice_date).slice(0, 10) +
          (inv.cancelled_at ? " · oli tühistatud" : " · ei olnud tühistatud") +
          (leavesGap ? " · jättis numbrireasse augu" : "")
      );

      // Cancelling already removed these; deleting an invoice that was never
      // cancelled has to remove them here, or the cash book would keep money
      // for a sale that no longer exists.
      await client.query("DELETE FROM ledger_entries WHERE user_id = $1 AND invoice_id = $2", [req.shopId, id]);
      await client.query("DELETE FROM stock_movements WHERE user_id = $1 AND invoice_id = $2", [req.shopId, id]);
      await client.query("DELETE FROM invoices WHERE id = $2 AND user_id = $1", [req.shopId, id]);

      // Free the number rather than skipping it, when it was the last one out.
      const month = String(inv.invoice_date).slice(0, 10).slice(0, 7);
      if (String(settings.invoice_month || "") === month && Number(settings.invoice_seq) === mine) {
        await client.query("UPDATE settings SET invoice_seq = $2 WHERE user_id = $1", [req.shopId, mine - 1]);
      }

      return { nr: inv.nr, leavesGap: leavesGap };
    });

    res.json({ ok: true, nr: removed.nr, leavesGap: removed.leavesGap, state: await loadState(req.shopId) });
  })
);

// ---------------------------------------------------------------- passwords

// Change your own. The current one is required, so a walk-up at an unlocked
// till cannot lock the owner out of their own shop.
app.put(
  "/api/me/password",
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body.current || "");
    const next = String(req.body.password || "");
    if (next.length < 8) {
      return res.status(400).json({ error: "Uus parool peab olema vähemalt 8 tähemärki." });
    }
    const u = await query("SELECT password_hash FROM users WHERE id = $1", [req.userId]);
    if (!u.rowCount || !(await verifyPassword(current, u.rows[0].password_hash))) {
      return res.status(401).json({ error: "Praegune parool ei klapi." });
    }
    await query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.userId, await hashPassword(next)]);
    res.json({ ok: true });
  })
);

// Reset someone else's, for the barber who has forgotten theirs. The owner
// never learns the old one — it is replaced, not revealed.
app.put(
  "/api/staff/:id/password",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const next = String(req.body.password || "");
    if (next.length < 8) {
      return res.status(400).json({ error: "Parool peab olema vähemalt 8 tähemärki." });
    }
    const r = await query(
      "UPDATE users SET password_hash = $3 WHERE id = $2 AND shop_id = $1 RETURNING id, email",
      [req.shopId, id, await hashPassword(next)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Kontot ei leitud." });
    await query(
      "INSERT INTO audit_log (shop_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)",
      [req.shopId, req.userId, "parool lähtestatud", r.rows[0].email]
    );
    res.json({ ok: true, state: await loadState(req.shopId) });
  })
);

// ------------------------------------------------------------------- staff

// Accounts that work for this shop. Creating one is how a barber gets a login;
// the account points at the owner's shop_id, so it sees the same books rather
// than an empty till of its own.
app.post(
  "/api/staff",
  ownerOnly,
  wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim().slice(0, 120);
    const role = ROLES.includes(req.body.role) ? req.body.role : "barber";
    if (!isEmail(email)) return res.status(400).json({ error: "Vigane e-posti aadress." });
    if (password.length < 8) return res.status(400).json({ error: "Parool peab olema vähemalt 8 tähemärki." });

    const exists = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (exists.rowCount) return res.status(409).json({ error: "Selle e-postiga konto on juba olemas." });

    const user = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO users (email, password_hash, name, shop_id, role)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, active, created_at`,
        [email, await hashPassword(password), name || null, req.shopId, role]
      );
      await audit(client, req.shopId, req.userId, "konto loodud", null, email + " · " + role);
      return r.rows[0];
    });

    res.status(201).json({ user, state: await loadState(req.shopId) });
  })
);

app.put(
  "/api/staff/:id",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    // The shop must keep an owner, and an owner must not be able to lock
    // themselves out of their own books by accident.
    if (id === req.userId && (req.body.role === "barber" || req.body.active === false)) {
      return res.status(409).json({ error: "Iseenda õigusi ei saa ära võtta." });
    }
    const role = req.body.role === undefined ? null : (ROLES.includes(req.body.role) ? req.body.role : null);
    if (req.body.role !== undefined && !role) {
      return res.status(400).json({ error: "Tundmatu roll." });
    }

    const r = await query(
      `UPDATE users SET role = COALESCE($3, role), active = COALESCE($4, active),
              name = COALESCE($5, name)
        WHERE id = $2 AND shop_id = $1
        RETURNING id, email, name, role, active, created_at`,
      [
        req.shopId, id, role,
        req.body.active === undefined ? null : Boolean(req.body.active),
        req.body.name === undefined ? null : String(req.body.name).trim().slice(0, 120),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Kontot ei leitud." });
    res.json({ user: r.rows[0], state: await loadState(req.shopId) });
  })
);

// Which parts of the app this account may open. Owner-only, and refused on an
// owner's own row: the switches describe what a barber may reach, and an owner
// who could switch their own access off would be one click from locking
// themselves out of their own books.
app.put(
  "/api/staff/:id/permissions",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const target = await query("SELECT id, role FROM users WHERE id = $2 AND shop_id = $1", [req.shopId, id]);
    if (!target.rowCount) return res.status(404).json({ error: "Kontot ei leitud." });
    if (target.rows[0].role === "omanik") {
      return res.status(409).json({
        error: "Omanikul on alati kõik õigused. Piiramiseks muuda roll enne barberiks.",
      });
    }

    const perms = cleanPermissions(req.body.permissions);
    const r = await query(
      "UPDATE users SET permissions = $3 WHERE id = $2 AND shop_id = $1 RETURNING id, email, name, role, active, permissions, created_at",
      [req.shopId, id, JSON.stringify(perms)]
    );
    await query(
      "INSERT INTO audit_log (shop_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)",
      [
        req.shopId, req.userId, "õigused muudetud",
        r.rows[0].email + " · " + (AREAS.filter((a) => perms[a]).join(", ") || "ei midagi"),
      ]
    );
    res.json({ user: r.rows[0], state: await loadState(req.shopId) });
  })
);

// Switched off, never deleted: invoices point at their creator, and a barber
// who leaves should not erase who rang up last year's sales.
app.delete(
  "/api/staff/:id",
  ownerOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.userId) return res.status(409).json({ error: "Iseennast ei saa sulgeda." });
    const r = await query(
      "UPDATE users SET active = false WHERE id = $2 AND shop_id = $1 AND role <> 'omanik' RETURNING id, email",
      [req.shopId, id]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Kontot ei leitud või on see omaniku oma." });
    res.json({ ok: true, state: await loadState(req.shopId) });
  })
);

// ---------------------------------------------------------------- barbers

// The chair, not the login. A guest barber may never have an account, and the
// shop has more barbers than accounts — so these are their own rows, with an
// optional link to a login. When that link is set, the person sees their own
// prices in Hinnakiri without anyone having to pick them from a list.
app.post(
  "/api/barbers",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "Barberi nimi puudub." });
    const slug = String(req.body.slug || name).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "barber";

    const exists = await query("SELECT id FROM barbers WHERE user_id = $1 AND slug = $2", [req.shopId, slug]);
    if (exists.rowCount) return res.status(409).json({ error: "Selle nimega barber on juba olemas." });

    const r = await query(
      `INSERT INTO barbers (user_id, slug, name, tier, phone, sort_order)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort_order)+1,0) FROM barbers WHERE user_id=$1))
       RETURNING *`,
      [req.shopId, slug, name, String(req.body.tier || "").slice(0, 60), String(req.body.phone || "").slice(0, 40)]
    );

    // A new barber starts on the shop's own price list rather than on nothing,
    // so the till has a number to put on a line from the first sale.
    const svc = await query("SELECT id, price FROM services WHERE user_id = $1 AND active", [req.shopId]);
    for (const s of svc.rows) {
      await query(
        "INSERT INTO barber_prices (barber_id, service_id, price, offered) VALUES ($1,$2,$3,true)",
        [r.rows[0].id, s.id, Number(s.price)]
      );
    }
    res.status(201).json({ barber: r.rows[0], state: await loadState(req.shopId) });
  })
);

app.put(
  "/api/barbers/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    // Linking to an account is what makes "my own prices" work, so the account
    // has to belong to this shop — otherwise one shop could point at another's.
    let accountId = null;
    if (req.body.accountId) {
      const u = await query("SELECT id FROM users WHERE id = $2 AND shop_id = $1", [req.shopId, Number(req.body.accountId)]);
      if (!u.rowCount) return res.status(404).json({ error: "Kontot ei leitud." });
      accountId = u.rows[0].id;
    }
    const r = await query(
      `UPDATE barbers SET name = COALESCE($3, name), tier = COALESCE($4, tier),
              phone = COALESCE($5, phone),
              account_id = CASE WHEN $6::boolean THEN $7 ELSE account_id END
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.shopId, id,
        req.body.name === undefined ? null : String(req.body.name).trim().slice(0, 120),
        req.body.tier === undefined ? null : String(req.body.tier).slice(0, 60),
        req.body.phone === undefined ? null : String(req.body.phone).slice(0, 40),
        req.body.accountId !== undefined,
        accountId,
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Barberit ei leitud." });
    res.json({ barber: r.rows[0], state: await loadState(req.shopId) });
  })
);

// One barber's price for one service, and whether they perform it at all.
app.put(
  "/api/barbers/:id/prices/:serviceId",
  areaOnly("price"),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const serviceId = Number(req.params.serviceId);

    const owned = await query("SELECT id FROM barbers WHERE id = $2 AND user_id = $1", [req.shopId, id]);
    if (!owned.rowCount) return res.status(404).json({ error: "Barberit ei leitud." });
    const svc = await query("SELECT id FROM services WHERE id = $2 AND user_id = $1", [req.shopId, serviceId]);
    if (!svc.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });

    const offered = req.body.offered === undefined ? true : Boolean(req.body.offered);
    await query(
      `INSERT INTO barber_prices (barber_id, service_id, price, offered) VALUES ($1,$2,$3,$4)
       ON CONFLICT (barber_id, service_id)
       DO UPDATE SET price = EXCLUDED.price, offered = EXCLUDED.offered`,
      [id, serviceId, money(req.body.price === undefined ? 0 : req.body.price), offered]
    );
    res.json({ state: await loadState(req.shopId) });
  })
);

app.delete(
  "/api/barbers/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    // Soft delete: past invoices name the barber in their line descriptions,
    // and a removed row should not make that history unexplainable.
    const r = await query(
      "UPDATE barbers SET active = false WHERE id = $2 AND user_id = $1 RETURNING id, name",
      [req.shopId, Number(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Barberit ei leitud." });
    res.json({ ok: true, state: await loadState(req.shopId) });
  })
);

// --------------------------------------------------------------- customers

// A regular, and the prices they have been promised. Those prices are only a
// default the till fills in — the invoice line still stores its own copy, so
// changing a customer's price never rewrites an invoice already issued.
app.post(
  "/api/customers",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: "Kliendi nimi puudub." });
    const r = await query(
      `INSERT INTO customers (user_id, name, details, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [
        req.shopId, name,
        String(req.body.details || "").trim().slice(0, 500),
        String(req.body.note || "").trim().slice(0, 300),
      ]
    );
    res.status(201).json({ customer: { ...r.rows[0], prices: {} }, state: await loadState(req.shopId) });
  })
);

app.put(
  "/api/customers/:id",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE customers SET name = COALESCE($3, name), details = COALESCE($4, details),
              note = COALESCE($5, note)
        WHERE id = $2 AND user_id = $1 RETURNING *`,
      [
        req.shopId, id,
        req.body.name === undefined ? null : String(req.body.name).trim().slice(0, 200),
        req.body.details === undefined ? null : String(req.body.details).trim().slice(0, 500),
        req.body.note === undefined ? null : String(req.body.note).trim().slice(0, 300),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Klienti ei leitud." });
    res.json({ customer: r.rows[0], state: await loadState(req.shopId) });
  })
);

// Set or clear one agreed price. A null price removes the agreement rather
// than storing a zero, which would mean "free".
app.put(
  "/api/customers/:id/prices/:serviceId",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const serviceId = Number(req.params.serviceId);

    const owned = await query("SELECT id FROM customers WHERE id = $2 AND user_id = $1", [req.shopId, id]);
    if (!owned.rowCount) return res.status(404).json({ error: "Klienti ei leitud." });
    const svc = await query("SELECT id FROM services WHERE id = $2 AND user_id = $1", [req.shopId, serviceId]);
    if (!svc.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });

    if (req.body.price === null || req.body.price === "") {
      await query("DELETE FROM customer_prices WHERE customer_id = $1 AND service_id = $2", [id, serviceId]);
    } else {
      await query(
        `INSERT INTO customer_prices (customer_id, service_id, price) VALUES ($1,$2,$3)
         ON CONFLICT (customer_id, service_id) DO UPDATE SET price = EXCLUDED.price`,
        [id, serviceId, money(req.body.price)]
      );
    }
    res.json({ state: await loadState(req.shopId) });
  })
);

app.delete(
  "/api/customers/:id",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const r = await query(
      "UPDATE customers SET active = false WHERE id = $2 AND user_id = $1 RETURNING id",
      [req.shopId, Number(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Klienti ei leitud." });
    res.json({ ok: true, state: await loadState(req.shopId) });
  })
);

// ------------------------------------------------------------- kassaraamat

// Offered in the dropdown; the operator may also type their own.
const LEDGER_CATEGORIES = [
  "Teenuste müük", "Kaubamüük", "Kaubavaru", "Rent", "Töövahendid", "Palk", "Muu",
];

app.post(
  "/api/ledger",
  areaOnly("cash"),
  wrap(async (req, res) => {
    const date = isDate(req.body.date) ? req.body.date : today();
    const kind = req.body.kind === "tulu" ? "tulu" : "kulu";
    // The list is what the dropdown offers, not a whitelist: picking "Muu"
    // lets the operator name the category themselves, and that name has to
    // survive to the cash book or the entry says nothing.
    const category = String(req.body.category || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Muu";
    const cash = Math.max(0, num(req.body.cash));
    const card = Math.max(0, num(req.body.card));
    const bank = Math.max(0, num(req.body.bank));
    if (cents(cash) + cents(card) + cents(bank) === 0) {
      return res.status(400).json({ error: "Sisesta summa sularaha, kaardi või ülekande lahtrisse." });
    }
    const r = await query(
      `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card, bank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.shopId, date, kind, category, String(req.body.description || "").slice(0, 300), cash, card, bank]
    );
    res.status(201).json({ entry: r.rows[0] });
  })
);

app.delete(
  "/api/ledger/:id",
  areaOnly("cash"),
  wrap(async (req, res) => {
    const r = await query("SELECT invoice_id FROM ledger_entries WHERE id = $2 AND user_id = $1", [
      req.shopId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Kannet ei leitud." });
    if (r.rows[0].invoice_id) {
      return res.status(409).json({
        error: "See kanne kuulub arve juurde ja seda ei saa eraldi kustutada.",
      });
    }
    await query("DELETE FROM ledger_entries WHERE id = $2 AND user_id = $1", [
      req.shopId,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);

// -------------------------------------------------------------------- ladu

app.post(
  "/api/stock-movements",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const productId = Number(req.body.productId);
    const type = req.body.type === "out" ? "out" : "in";
    const qty = num(req.body.qty);
    const price = Math.max(0, num(req.body.price));
    const date = isDate(req.body.date) ? req.body.date : today();
    if (!(qty > 0)) return res.status(400).json({ error: "Kogus peab olema suurem kui null." });

    const owned = await query("SELECT id, name FROM products WHERE id = $2 AND user_id = $1", [
      req.shopId,
      productId,
    ]);
    if (!owned.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });

    if (type === "out") {
      const q = await query(
        `SELECT COALESCE(SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END), 0) AS qty
           FROM stock_movements WHERE user_id = $1 AND product_id = $2`,
        [req.shopId, productId]
      );
      const have = Number(q.rows[0].qty);
      if (have < qty) {
        return res.status(409).json({ error: "Laos on " + have + " tk, maha kanda proovid " + qty + " tk." });
      }
    }

    const r = await query(
      `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.shopId, productId, date, type, qty, price]
    );
    res.status(201).json({ movement: { ...r.rows[0], product_name: owned.rows[0].name } });
  })
);

app.delete(
  "/api/stock-movements/:id",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const r = await query("SELECT invoice_id FROM stock_movements WHERE id = $2 AND user_id = $1", [
      req.shopId,
      Number(req.params.id),
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Liikumist ei leitud." });
    if (r.rows[0].invoice_id) {
      return res.status(409).json({ error: "See liikumine tuli müügist ja seda ei saa eraldi kustutada." });
    }
    await query("DELETE FROM stock_movements WHERE id = $2 AND user_id = $1", [
      req.shopId,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ static

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api", (req, res) => res.status(404).json({ error: "Tundmatu API otspunkt." }));

// The public site is a saved copy of fibarbers.ee living in public/site.
// Its pages carry <base href="/site/"> so their relative assets resolve no
// matter which URL served them, and its internal links are root-absolute —
// so the original paths are mapped here rather than rewritten in the HTML.
const SITE = path.join(__dirname, "..", "public", "site");
const sitePage = (file) => (req, res) => res.sendFile(path.join(SITE, file));

app.get("/", sitePage("home.html"));
app.get("/pages/broneeri-aeg", sitePage("broneeri.html"));
app.get("/collections/all", sitePage("tooted.html"));
app.get("/pages/contact", sitePage("kontakt.html"));

// The till. It loads only same-origin code and Google Fonts and has no inline
// <script>, so it can carry a strict Content-Security-Policy — which the saved
// storefront pages cannot, hence scoping it to this route. 'unsafe-inline' is
// kept for style only, because the design uses inline style attributes; scripts
// stay 'self'-only, so an injected <script> or onclick would not run.
app.get(["/app", "/app/*"], (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  res.sendFile(path.join(__dirname, "..", "public", "app.html"));
});

// Anything else on the shop front — a product page, a policy, the English
// version — was not part of the saved copy, so send it to the live site
// rather than showing a page that half works.
app.get("*", (req, res) => {
  res.redirect(302, "https://fibarbers.ee" + req.originalUrl);
});

// Errors thrown inside a route land here. `status` is set deliberately by the
// sale transaction for the cases the till should show verbatim.
app.use((err, req, res, next) => {
  // A malformed or oversized request body (express.json) shouldn't echo the
  // parser's internal message — return a generic 400 instead.
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    return res.status(400).json({ error: "Vigane päring." });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Serveri viga. Proovi uuesti." : err.message });
});

app.listen(PORT, () => {
  console.log("Fi Barbershop server kuulab pordil " + PORT + " — http://localhost:" + PORT);
});
