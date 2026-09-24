// routes/invoices.js — the life of an invoice.
//
// Two ways in, one set of rules (lib/invoicing.js):
//   * the till (POST /sales): everything at once — number, goods off the
//     shelf, money in the cash book — because the customer is at the counter
//     and has already paid;
//   * a composed invoice: a draft built up over days (no number, nothing
//     moved, nothing booked), then issued — paid on the spot or on credit —
//     and, for credit, marked paid when the transfer arrives.
//
// After that an invoice can be cancelled (number kept, money and goods put
// back), un-cancelled within a day, or deleted for good — by anyone with the
// "Arvete kustutamine" switch, which every barber has unless the owner turns
// it off. Marking an invoice paid stays with the owner.

const express = require("express");

const { withTransaction, cents, euros } = require("../db");
const { requireAuth, ownerOnly, areaOnly } = require("../auth");
const { wrap, httpError, moneyOr0, optionalId, paramId, text, date } = require("../lib/http");
const { today, localDate, addDays } = require("../lib/dates");
const {
  normaliseLines, linesFromRows, totals, assertRefs, insertLines,
  lockSettings, allocateNumber, reserveStock, moveStockOut, bookIncome, audit,
} = require("../lib/invoicing");
const { sendState } = require("../state");

const router = express.Router();

// ------------------------------------------------------------------ helpers

// Optional buyer block. Left empty for a walk-in, and the invoice then reads
// "Eraklient".
function buyerOf(body) {
  return {
    buyerName: text(body.buyerName, 200),
    buyerDetails: text(body.buyerDetails, 500),
    customerId: optionalId(body.customerId, "klient"),
  };
}

const tipOf = (body) => moneyOr0(body.tip, "jootraha");

// Paying now must balance to the cent. The client's own total is a display
// value and is never trusted: the server has already worked it out.
function assertPaid(totalCents, parts) {
  const paid = parts.reduce((s, v) => s + cents(v), 0);
  if (paid !== totalCents) {
    throw httpError(400,
      "Makse ei klapi: tasuda " + euros(totalCents).toFixed(2) + " €, sisestatud " +
        euros(paid).toFixed(2) + " €.");
  }
}

// Fetch one invoice belonging to this shop, or throw. Every route below starts
// here, which is what keeps one shop out of another's books.
async function getInvoice(client, shopId, invoiceId, forUpdate = false) {
  const r = await client.query(
    "SELECT * FROM invoices WHERE id = $2 AND user_id = $1" + (forUpdate ? " FOR UPDATE" : ""),
    [shopId, invoiceId]
  );
  if (!r.rowCount) throw httpError(404, "Arvet ei leitud.");
  return r.rows[0];
}

async function readLines(client, invoiceId) {
  const r = await client.query(
    "SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, id",
    [invoiceId]
  );
  return r.rows;
}

// -------------------------------------------------------------------- till

router.post(
  "/sales",
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const when = date(body.date, today());
    const lines = normaliseLines(body.lines);
    const buyer = buyerOf(body);
    const tip = tipOf(body);
    const cash = moneyOr0(body.cash, "sularaha summa");
    const card = moneyOr0(body.card, "kaardi summa");

    const invoice = await withTransaction(async (client) => {
      // The settings lock serialises numbering and fixes the VAT rate in
      // force at the moment of the sale.
      const settings = await lockSettings(client, req.shopId);
      await assertRefs(client, req.shopId, lines, buyer.customerId);
      const t = totals(lines, tip, settings.vat_rate);
      assertPaid(t.totalCents, [cash, card]);
      await reserveStock(client, req.shopId, lines);
      const nr = await allocateNumber(client, req.shopId, when);

      const inv = await client.query(
        `INSERT INTO invoices
           (user_id, nr, invoice_date, due_date, buyer_name, buyer_details, customer_id,
            net, vat, vat_rate, tip, total, cash, card, status, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'makstud',now(),$15) RETURNING *`,
        [
          req.shopId, nr, when, addDays(when, settings.payment_days),
          buyer.buyerName || "Eraklient",
          // The walk-in note only fits a sale with no named buyer. Once the
          // till has been given a name, an empty details line stays empty
          // rather than telling a company how its own invoice was paid.
          buyer.buyerDetails || (buyer.buyerName ? "" : "Sularaha-/kaardimüük salongis"),
          buyer.customerId, t.net, t.vat, t.rate, tip, t.total, cash, card, req.userId,
        ]
      );
      const created = inv.rows[0];
      await insertLines(client, created.id, lines);
      await moveStockOut(client, req.shopId, created.id, lines, when);
      await bookIncome(client, req.shopId, created, lines, when);
      return created;
    });

    await sendState(req, res, { invoice }, 201);
  })
);

// ----------------------------------------------------------------- drafts

// A draft is not yet a document: no number is minted, no goods leave the
// shelf, nothing is booked. The old code did move stock here — on creation
// and again on every edit — so a jar on a draft edited twice left the shelf
// three times by the time the invoice was issued.
router.post(
  "/invoices",
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const when = date(body.date, today());
    const lines = normaliseLines(body.lines);
    const buyer = buyerOf(body);
    const tip = tipOf(body);

    const invoice = await withTransaction(async (client) => {
      const s = await client.query("SELECT vat_rate, payment_days FROM settings WHERE user_id = $1", [req.shopId]);
      if (!s.rowCount) throw httpError(400, "Seaded puuduvad.");
      await assertRefs(client, req.shopId, lines, buyer.customerId);
      const t = totals(lines, tip, s.rows[0].vat_rate);
      const inv = await client.query(
        `INSERT INTO invoices
           (user_id, nr, invoice_date, due_date, buyer_name, buyer_details, customer_id,
            net, vat, vat_rate, tip, total, status, created_by)
         VALUES ($1,'',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'mustand',$12) RETURNING *`,
        [
          req.shopId, when, addDays(when, s.rows[0].payment_days),
          buyer.buyerName || "Eraklient", buyer.buyerDetails, buyer.customerId,
          t.net, t.vat, t.rate, tip, t.total, req.userId,
        ]
      );
      await insertLines(client, inv.rows[0].id, lines);
      return inv.rows[0];
    });

    await sendState(req, res, { invoice }, 201);
  })
);

// Replace a draft's contents. Only a draft: once a number is on a document it
// is no longer ours to rewrite.
router.put(
  "/invoices/:id",
  requireAuth,
  wrap(async (req, res) => {
    const invoiceId = paramId(req);
    const body = req.body || {};
    const lines = normaliseLines(body.lines);
    const buyer = buyerOf(body);
    const tip = tipOf(body);

    const invoice = await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, invoiceId, true);
      if (cur.status !== "mustand") {
        throw httpError(409, "Ainult mustandit saab muuta. Esitatud arve tuleb tühistada ja uus koostada.");
      }
      const when = date(body.date, String(cur.invoice_date).slice(0, 10));
      await assertRefs(client, req.shopId, lines, buyer.customerId);
      const s = await client.query("SELECT vat_rate FROM settings WHERE user_id = $1", [req.shopId]);
      const t = totals(lines, tip, s.rows[0] && s.rows[0].vat_rate);

      await client.query("DELETE FROM invoice_lines WHERE invoice_id = $1", [invoiceId]);
      await insertLines(client, invoiceId, lines);
      const r = await client.query(
        `UPDATE invoices SET invoice_date = $3, buyer_name = $4, buyer_details = $5,
                customer_id = $6, net = $7, vat = $8, vat_rate = $9, tip = $10, total = $11
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [
          req.shopId, invoiceId, when, buyer.buyerName || "Eraklient", buyer.buyerDetails,
          buyer.customerId, t.net, t.vat, t.rate, tip, t.total,
        ]
      );
      return r.rows[0];
    });

    await sendState(req, res, { invoice });
  })
);

// Delete a DRAFT. Not a document, no number, nothing booked or moved — so
// anyone may throw one away and nothing in the accounts notices.
router.delete(
  "/invoices/:id",
  requireAuth,
  wrap(async (req, res) => {
    const invoiceId = paramId(req);
    await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, invoiceId, true);
      if (cur.status !== "mustand") {
        throw httpError(409,
          "Esitatud arvet ei saa kustutada — number peab numbrireas alles jääma. Kasuta tühistamist.");
      }
      await client.query("DELETE FROM invoices WHERE id = $2 AND user_id = $1", [req.shopId, invoiceId]);
    });
    await sendState(req, res, { ok: true });
  })
);

// ------------------------------------------------------------------- issue

// The moment a draft becomes a document: it is dated today, the number is
// minted, the goods leave the shelf, and either the money is taken now or the
// invoice goes out on credit with a due date.
router.post(
  "/invoices/:id/issue",
  requireAuth,
  wrap(async (req, res) => {
    const invoiceId = paramId(req);
    const body = req.body || {};
    const payNow = body.payNow !== false;
    // An invoice is dated the day it is issued, not the day the draft was
    // started — otherwise Monday's draft issued on Friday would carry
    // Monday's date and, worse, possibly last month's number.
    const when = date(body.date, today());
    const cash = payNow ? moneyOr0(body.cash, "sularaha summa") : 0;
    const card = payNow ? moneyOr0(body.card, "kaardi summa") : 0;

    const invoice = await withTransaction(async (client) => {
      const settings = await lockSettings(client, req.shopId);
      const cur = await getInvoice(client, req.shopId, invoiceId, true);
      if (cur.status !== "mustand") throw httpError(409, "See arve on juba esitatud.");

      const rows = await readLines(client, invoiceId);
      if (!rows.length) throw httpError(400, "Arvel pole ühtegi rida.");
      const lines = linesFromRows(rows);

      // Totals are worked out again with the VAT rate in force today: the
      // draft may have been saved under a different one.
      const t = totals(lines, cur.tip, settings.vat_rate);
      // Paying later means nothing is entered — and, crucially, no cash-book
      // entry is written, because no money has arrived.
      if (payNow) assertPaid(t.totalCents, [cash, card]);

      await reserveStock(client, req.shopId, lines);
      const nr = await allocateNumber(client, req.shopId, when);
      await moveStockOut(client, req.shopId, invoiceId, lines, when);

      const r = await client.query(
        `UPDATE invoices SET nr = $3, status = $4, cash = $5, card = $6, bank = 0,
                invoice_date = $7, due_date = $8, net = $9, vat = $10, vat_rate = $11, total = $12,
                paid_at = CASE WHEN $4 = 'makstud' THEN now() ELSE NULL END
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [
          req.shopId, invoiceId, nr, payNow ? "makstud" : "esitatud", cash, card,
          when, addDays(when, settings.payment_days), t.net, t.vat, t.rate, t.total,
        ]
      );
      const inv = r.rows[0];
      if (payNow) await bookIncome(client, req.shopId, inv, rows, when);
      await audit(client, req.shopId, req.userId, payNow ? "arve esitatud ja makstud" : "arve esitatud", invoiceId, nr);
      return inv;
    });

    await sendState(req, res, { invoice });
  })
);

// --------------------------------------------------------------------- pay

// The money arrived. This is where a credit invoice finally reaches the cash
// book — weeks after it was issued, which is the whole reason the cash-book
// entry is not written at issue time.
router.post(
  "/invoices/:id/pay",
  ownerOnly,
  wrap(async (req, res) => {
    const invoiceId = paramId(req);
    const body = req.body || {};
    const paidDate = date(body.date, today());
    const cash = moneyOr0(body.cash, "sularaha summa");
    const card = moneyOr0(body.card, "kaardi summa");

    const invoice = await withTransaction(async (client) => {
      const cur = await getInvoice(client, req.shopId, invoiceId, true);
      if (cur.status === "tühistatud") throw httpError(409, "Tühistatud arvet ei saa makstuks märkida.");
      if (cur.status === "mustand") throw httpError(409, "Mustand tuleb enne esitada.");
      if (cur.status === "makstud") throw httpError(409, "See arve on juba makstud.");

      const totalCents = cents(cur.total);
      // Default: whatever cash and card do not cover came in by transfer,
      // which is what a credit invoice normally means. Paying more in cash or
      // card than is owed used to produce a negative transfer that balanced
      // the sum; it is refused now.
      const bank = body.bank === undefined
        ? euros(totalCents - cents(cash) - cents(card))
        : moneyOr0(body.bank, "ülekande summa");
      if (bank < 0) throw httpError(400, "Makse ületab arve summa " + euros(totalCents).toFixed(2) + " €.");
      assertPaid(totalCents, [cash, card, bank]);

      const r = await client.query(
        `UPDATE invoices SET status = 'makstud', paid_at = now(), cash = $3, card = $4, bank = $5
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [req.shopId, invoiceId, cash, card, bank]
      );
      const inv = r.rows[0];
      await bookIncome(client, req.shopId, inv, await readLines(client, invoiceId), paidDate);
      await audit(client, req.shopId, req.userId, "arve makstud", invoiceId, inv.nr);
      return inv;
    });

    await sendState(req, res, { invoice });
  })
);

// ------------------------------------------------------------------ cancel

// Void an invoice that should never have been issued. The number is kept and
// the row stays visible as TÜHISTATUD: deleting it would leave a hole in the
// sequence that cannot be explained to an accountant later. The cash-book
// entry and the stock movements it created go, because no money changed
// hands and no goods left the shelf.
router.post(
  "/invoices/:id/cancel",
  areaOnly("void"),
  wrap(async (req, res) => {
    const invoiceId = paramId(req);
    // Required, not optional: one stray Enter used to void an invoice and
    // leave nothing behind to explain it.
    const reason = text(req.body.reason, 300);
    if (!reason) return res.status(400).json({ error: "Tühistamiseks on põhjus kohustuslik." });

    await withTransaction(async (client) => {
      const inv = await getInvoice(client, req.shopId, invoiceId, true);
      if (inv.status === "mustand") {
        throw httpError(409, "Mustandit ei tühistata — selle saab lihtsalt kustutada.");
      }
      if (inv.cancelled_at) throw httpError(409, "See arve on juba tühistatud.");

      // paid_at is deliberately left in place: it is the only record of what
      // this invoice was before it was voided, and un-cancelling reads it.
      await client.query("DELETE FROM ledger_entries WHERE user_id = $1 AND invoice_id = $2", [req.shopId, invoiceId]);
      await client.query("DELETE FROM stock_movements WHERE user_id = $1 AND invoice_id = $2", [req.shopId, invoiceId]);
      await client.query(
        `UPDATE invoices SET cancelled_at = now(), cancel_reason = $3, status = 'tühistatud'
          WHERE id = $2 AND user_id = $1`,
        [req.shopId, invoiceId, reason]
      );
      await audit(client, req.shopId, req.userId, "arve tühistatud", invoiceId, inv.nr + " · " + reason);
    });

    await sendState(req, res, { ok: true });
  })
);

// Undo a cancellation made by mistake, within a day of making it. Everything
// needed to rebuild the cash-book entry and the stock movements is still on
// the invoice and its lines, so this restores rather than re-creates.
const UNCANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

router.post(
  "/invoices/:id/uncancel",
  areaOnly("void"),
  wrap(async (req, res) => {
    const invoiceId = paramId(req);

    const invoice = await withTransaction(async (client) => {
      const inv = await getInvoice(client, req.shopId, invoiceId, true);
      if (!inv.cancelled_at) throw httpError(409, "See arve ei ole tühistatud.");
      if (Date.now() - new Date(inv.cancelled_at).getTime() > UNCANCEL_WINDOW_MS) {
        throw httpError(409, "Tühistamise saab tagasi võtta 24 tunni jooksul. Koosta uus arve.");
      }

      const rows = await readLines(client, invoiceId);
      const lines = linesFromRows(rows);
      await reserveStock(client, req.shopId, lines);
      await moveStockOut(client, req.shopId, invoiceId, lines, String(inv.invoice_date).slice(0, 10));

      // paid_at survived the cancellation, so it says what this invoice was —
      // and on which day the money came in.
      const wasPaid = Boolean(inv.paid_at);
      const r = await client.query(
        `UPDATE invoices SET cancelled_at = NULL, cancel_reason = '', status = $3
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [req.shopId, invoiceId, wasPaid ? "makstud" : "esitatud"]
      );
      if (wasPaid) await bookIncome(client, req.shopId, r.rows[0], rows, localDate(inv.paid_at));
      await audit(client, req.shopId, req.userId, "tühistamine tagasi võetud", invoiceId, inv.nr);
      return r.rows[0];
    });

    await sendState(req, res, { invoice });
  })
);

// ------------------------------------------------------ delete permanently

// Remove an invoice from the books entirely. Anyone with the "Arvete
// kustutamine" switch — every barber unless the owner turned it off.
//
// Any issued invoice, cancelled or not. Deleting anything but the month's
// last invoice leaves a gap in the numbering, and the confirmation says so.
// What this does guarantee is that the books never disagree with themselves:
// the cash-book entry and the stock movements go with it, the month's last
// number becomes free again (numbering reads the invoices themselves), and an
// audit row survives carrying the number, the buyer and the amount.
router.delete(
  "/invoices/:id/permanent",
  areaOnly("void"),
  wrap(async (req, res) => {
    const invoiceId = paramId(req);

    const removed = await withTransaction(async (client) => {
      // Held so no number can be minted while the sequence is being judged.
      await lockSettings(client, req.shopId);
      const inv = await getInvoice(client, req.shopId, invoiceId, true);
      if (inv.status === "mustand") {
        throw httpError(409, "Mustandi kustutamiseks kasuta tavalist kustutamist.");
      }

      const [prefix, seqPart] = String(inv.nr).split("-");
      const later = await client.query(
        `SELECT 1 FROM invoices
          WHERE user_id = $1 AND id <> $2 AND nr ~ $3 AND split_part(nr, '-', 2)::int > $4 LIMIT 1`,
        [req.shopId, invoiceId, "^" + prefix + "-[0-9]{1,6}$", Number(seqPart) || 0]
      );
      const leavesGap = later.rowCount > 0;

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
      await client.query("DELETE FROM ledger_entries WHERE user_id = $1 AND invoice_id = $2", [req.shopId, invoiceId]);
      await client.query("DELETE FROM stock_movements WHERE user_id = $1 AND invoice_id = $2", [req.shopId, invoiceId]);
      await client.query("DELETE FROM invoices WHERE id = $2 AND user_id = $1", [req.shopId, invoiceId]);
      return { nr: inv.nr, leavesGap };
    });

    await sendState(req, res, { ok: true, nr: removed.nr, leavesGap: removed.leavesGap });
  })
);

module.exports = router;
