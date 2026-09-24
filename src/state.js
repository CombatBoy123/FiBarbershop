// state.js — the whole till in one read: settings, price list, products with
// their computed stock, invoices with lines, the cash book, every movement,
// staff, customers, barbers and the recent audit trail.
//
// Every write answers with this, so the client has exactly one way of
// learning what the books look like and nothing on screen can go stale. A
// barbershop's yearly volume is small enough that paging would be ceremony —
// if this ever gets slow, page `invoices` first.

const { query } = require("./db");
const { AREAS } = require("./auth");
const { referenceNumber } = require("./lib/invoicing");

async function loadState(shopId) {
  const [
    settings, services, products, stock, invoices, lines, ledger, moves,
    staff, customers, custPrices, barbers, barberPrices, auditRows,
  ] = await Promise.all([
    query("SELECT * FROM settings WHERE user_id = $1", [shopId]),
    query("SELECT * FROM services WHERE user_id = $1 AND active ORDER BY sort_order, id", [shopId]),
    query("SELECT * FROM products WHERE user_id = $1 AND active ORDER BY sort_order, id", [shopId]),
    query(
      `SELECT product_id, SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END) AS qty
         FROM stock_movements WHERE user_id = $1 GROUP BY product_id`,
      [shopId]
    ),
    // Drafts have no date-ordered place in the sequence yet, so they sort to
    // the top — they are the thing being worked on right now.
    query(
      `SELECT i.*,
              COALESCE(u.name, u.email, NULLIF(i.created_by_label, '')) AS created_by_name,
              u.email AS created_by_email
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
    query("SELECT * FROM customers WHERE user_id = $1 AND active ORDER BY name", [shopId]),
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
      `SELECT a.*, COALESCE(u.name, NULLIF(a.actor_label, '')) AS actor_name, u.email AS actor_email,
              i.nr AS invoice_nr
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN invoices i ON i.id = a.invoice_id
        WHERE a.shop_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
      [shopId]
    ),
  ]);

  const stockBy = new Map(stock.rows.map((r) => [r.product_id, Number(r.qty)]));
  const group = (rows, key, pick) => {
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r[key])) out.set(r[key], pick ? {} : []);
      if (pick) pick(out.get(r[key]), r);
      else out.get(r[key]).push(r);
    }
    return out;
  };
  const linesBy = group(lines.rows, "invoice_id");
  const pricesBy = group(custPrices.rows, "customer_id", (acc, p) => (acc[p.service_id] = Number(p.price)));
  const barberPriceBy = group(barberPrices.rows, "barber_id", (acc, p) => {
    acc[p.service_id] = { price: Number(p.price), offered: p.offered };
  });

  return {
    settings: settings.rows[0] || null,
    services: services.rows,
    products: products.rows.map((p) => ({ ...p, stock: stockBy.get(p.id) || 0 })),
    invoices: invoices.rows.map((i) => ({
      ...i,
      // Derived, never stored: the check digit is a pure function of the number.
      reference: i.nr ? referenceNumber(i.nr) : "",
      lines: linesBy.get(i.id) || [],
    })),
    ledger: ledger.rows,
    movements: moves.rows,
    staff: staff.rows,
    customers: customers.rows.map((c) => ({ ...c, prices: pricesBy.get(c.id) || {} })),
    barbers: barbers.rows.map((b) => ({ ...b, prices: barberPriceBy.get(b.id) || {} })),
    audit: auditRows.rows,
  };
}

// Who is looking. The client needs it to decide which tabs and buttons to
// draw; it is not the security boundary — every gated route checks again.
// `can` goes out already resolved so the client never re-implements the
// role-and-default rules and drifts out of step with them.
function describeMe(req) {
  return {
    id: req.userId,
    email: req.userEmail,
    name: req.userName,
    role: req.role,
    permissions: req.permissions,
    can: AREAS.reduce((acc, area) => Object.assign(acc, { [area]: req.can(area) }), {}),
  };
}

// The one way a route answers after a write: whatever it wants to say, plus
// the refreshed books and who is looking at them.
async function sendState(req, res, extra = {}, status = 200) {
  const state = await loadState(req.shopId);
  state.me = describeMe(req);
  res.status(status).json({ ...extra, state });
}

module.exports = { loadState, describeMe, sendState };
