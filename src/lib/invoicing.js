// invoicing.js — the rules every invoice obeys, whichever route writes it:
// what a valid line is, how totals and VAT are worked out, how a number is
// minted, when goods leave the shelf and when money reaches the cash book.
//
// The till, the composed-invoice flow and un-cancelling all go through these
// functions, so the two flows cannot drift apart on any of these rules.

const { cents, euros } = require("../db");
const { httpError, number, optionalId, text, MAX_MONEY } = require("./http");

const UNITS = ["tk", "h", "kord", "km", "päev"];

// ------------------------------------------------------------------ lines

// One line as the server will store it. Every field is taken from the request
// and written onto the invoice as a copy — the price list is read to offer a
// price, never to decide one. That is what lets a barber charge 40 € on one
// invoice without moving the 35 € everyone else pays.
function normaliseLines(raw) {
  const rawLines = Array.isArray(raw) ? raw : [];
  if (!rawLines.length) throw httpError(400, "Arvel pole ühtegi rida.");
  if (rawLines.length > 100) throw httpError(400, "Liiga palju ridu.");

  return rawLines.map((l) => {
    const name = text(l && l.name, 200);
    if (!name) throw httpError(400, "Real puudub nimi.");
    const label = (what) => what + " real: " + name;
    const line = {
      productId: optionalId(l.productId, label("toode")),
      serviceId: optionalId(l.serviceId, label("teenus")),
      barberId: optionalId(l.barberId, label("barber")),
      name,
      note: text(l.note, 300),
      unit: UNITS.includes(String(l.unit)) ? String(l.unit) : "tk",
      qty: number(l.qty === undefined ? 1 : l.qty, { min: 0.001, max: 100000, label: label("kogus") }),
      price: number(l.price === undefined ? 0 : l.price, { min: 0, max: MAX_MONEY, decimals: 2, label: label("hind") }),
      discount: number(l.discount === undefined || l.discount === "" ? 0 : l.discount,
        { min: 0, max: 100, decimals: 2, label: label("allahindlus (0–100%)") }),
    };
    return line;
  });
}

// Lines as read back from invoice_lines, in the shape the functions below take.
const linesFromRows = (rows) =>
  rows.map((l) => ({
    productId: l.product_id,
    qty: Number(l.qty),
    price: Number(l.price),
    discount: Number(l.discount),
  }));

// `price` stays the undiscounted unit price so the invoice can print both the
// list price and the reduction. The discount belongs in this one formula and
// nowhere else — a discount added as a negative line would corrupt the VAT base.
const lineCents = (l) => Math.round(cents(l.price) * Number(l.qty) * (1 - Number(l.discount || 0) / 100));
const linesTotalCents = (lines) => lines.reduce((sum, l) => sum + lineCents(l), 0);

// Prices include VAT; the tip is outside the VAT base.
function totals(lines, tip, vatRate) {
  const rate = Number(vatRate) || 0;
  const linesCents = linesTotalCents(lines);
  const netCents = rate > 0 ? Math.round(linesCents / (1 + rate / 100)) : linesCents;
  const totalCents = linesCents + cents(tip);
  return {
    rate,
    net: euros(netCents),
    vat: euros(linesCents - netCents),
    total: euros(totalCents),
    totalCents,
  };
}

// Every id a line names must belong to this shop. A foreign product id used
// to be written straight onto the line — and onto a stock movement booked
// against another shop's shelf.
async function assertRefs(client, shopId, lines, customerId) {
  const check = async (table, ids, what) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    const r = await client.query(
      "SELECT id FROM " + table + " WHERE user_id = $1 AND id = ANY($2::int[])",
      [shopId, unique]
    );
    if (r.rowCount !== unique.length) throw httpError(400, what + " ei leitud.");
  };
  await check("products", lines.map((l) => l.productId), "Toodet");
  await check("services", lines.map((l) => l.serviceId), "Teenust");
  await check("barbers", lines.map((l) => l.barberId), "Barberit");
  await check("customers", [customerId], "Klienti");
}

async function insertLines(client, invoiceId, lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await client.query(
      `INSERT INTO invoice_lines
         (invoice_id, product_id, service_id, barber_id, name, note, qty, unit, price, discount, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [invoiceId, l.productId, l.serviceId, l.barberId, l.name, l.note, l.qty, l.unit, l.price, l.discount, i]
    );
  }
}

// --------------------------------------------------------------- numbering

// Locks this shop's settings row for the rest of the transaction. Everything
// that mints a number takes this lock first, so two tills are served one at a
// time and can never be handed the same number.
async function lockSettings(client, shopId) {
  const s = await client.query("SELECT * FROM settings WHERE user_id = $1 FOR UPDATE", [shopId]);
  if (!s.rowCount) throw httpError(400, "Seaded puuduvad.");
  return s.rows[0];
}

// Mints the next number, MMYY-NNN, restarting every month. The caller must
// hold lockSettings().
//
// The number is the month's highest issued number plus one, read from the
// invoices themselves. The old code kept a single "current month + counter"
// in settings: one invoice dated into another month reset that counter, the
// next sale in the current month was handed a number that already existed,
// and from then on every sale failed with a server error.
//
// Reading the invoices also means the last number of a month is reissued
// when that invoice is deleted for good, and a number deleted from the middle
// stays a gap — the same outcome the counter used to be wound back for.
async function allocateNumber(client, shopId, date) {
  const [yyyy, mm] = date.split("-");
  const prefix = mm + yyyy.slice(2);
  const r = await client.query(
    `SELECT COALESCE(MAX(split_part(nr, '-', 2)::int), 0) AS seq
       FROM invoices WHERE user_id = $1 AND nr ~ $2`,
    [shopId, "^" + prefix + "-[0-9]{1,6}$"]
  );
  const seq = Number(r.rows[0].seq) + 1;
  // Kept current for anyone reading the old columns; nothing decides by them.
  await client.query(
    "UPDATE settings SET invoice_month = $2, invoice_seq = $3, invoice_year = $4 WHERE user_id = $1",
    [shopId, date.slice(0, 7), seq, Number(yyyy)]
  );
  return prefix + "-" + String(seq).padStart(3, "0");
}

// Estonian payment reference (viitenumber): the invoice number's digits plus a
// 7-3-1 check digit. Banks validate that digit — the old invoice printed the
// bare digits, which a bank refuses nine times out of ten.
function referenceNumber(nr) {
  const base = String(nr || "").replace(/\D/g, "").replace(/^0+/, "");
  if (!base) return "";
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    sum += Number(base[base.length - 1 - i]) * weights[i % 3];
  }
  return base + ((10 - (sum % 10)) % 10);
}

// -------------------------------------------------------------------- stock

const qtyKey = (q) => Math.round(Number(q) * 1000);

// Current shelf quantity for these products, as a Map of id -> qty.
async function stockOf(client, shopId, productIds) {
  const r = await client.query(
    `SELECT product_id, COALESCE(SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END), 0) AS qty
       FROM stock_movements WHERE user_id = $1 AND product_id = ANY($2::int[])
      GROUP BY product_id`,
    [shopId, productIds]
  );
  return new Map(r.rows.map((row) => [row.product_id, Number(row.qty)]));
}

// Checks that the shelf holds what these lines take, and locks the product
// rows until the transaction ends so nothing else can take it first.
//
// Quantities are summed per product before comparing: the old check looked at
// each line alone, so six one-jar lines passed against two jars on the shelf.
// Rows are locked in id order so two transactions can never deadlock over them.
async function reserveStock(client, shopId, lines) {
  const need = new Map();
  for (const l of lines) {
    if (l.productId) need.set(l.productId, (need.get(l.productId) || 0) + Number(l.qty));
  }
  if (!need.size) return;
  const ids = [...need.keys()].sort((a, b) => a - b);
  const p = await client.query(
    "SELECT id, name FROM products WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE",
    [shopId, ids]
  );
  if (p.rowCount !== ids.length) throw httpError(400, "Toodet ei leitud.");
  const have = await stockOf(client, shopId, ids);
  for (const row of p.rows) {
    const onShelf = have.get(row.id) || 0;
    const wanted = need.get(row.id);
    if (qtyKey(onShelf) < qtyKey(wanted)) {
      throw httpError(409, row.name + " — laos on " + onShelf + " tk, müüa proovid " + wanted + " tk.");
    }
  }
}

// The goods leave the shelf. Only ever called when an invoice is issued (or
// un-cancelled) — never for a draft, which is not yet a document.
async function moveStockOut(client, shopId, invoiceId, lines, date) {
  for (const l of lines) {
    if (!l.productId) continue;
    await client.query(
      `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price, invoice_id)
       VALUES ($1,$2,$3,'out',$4,$5,$6)`,
      [shopId, l.productId, date, l.qty, l.price, invoiceId]
    );
  }
}

// ----------------------------------------------------------------- the books

// The cash-book entry an invoice produces when the money actually arrives.
// For the till that is the moment of sale; for a credit invoice it is weeks
// later, which is exactly why this is a function and not an inline INSERT.
async function bookIncome(client, shopId, invoice, lines, date) {
  const hasProduct = lines.some((l) => l.product_id || l.productId);
  await client.query(
    `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card, bank, invoice_id)
     VALUES ($1,$2,'tulu',$3,$4,$5,$6,$7,$8)`,
    [
      shopId,
      date,
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

module.exports = {
  UNITS,
  normaliseLines,
  linesFromRows,
  lineCents,
  linesTotalCents,
  totals,
  assertRefs,
  insertLines,
  lockSettings,
  allocateNumber,
  referenceNumber,
  stockOf,
  reserveStock,
  moveStockOut,
  bookIncome,
  audit,
};
