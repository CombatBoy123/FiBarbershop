// routes/ledger.js — kassaraamat: money in and out that is not an invoice.
// Invoice income is written by the invoice routes and is not touched here.

const express = require("express");

const { withTransaction, cents } = require("../db");
const { areaOnly } = require("../auth");
const { wrap, httpError, moneyOr0, paramId, text, date } = require("../lib/http");
const { today } = require("../lib/dates");
const { audit } = require("../lib/invoicing");
const { sendState } = require("../state");

const router = express.Router();

router.post(
  "/ledger",
  areaOnly("cash"),
  wrap(async (req, res) => {
    const when = date(req.body.date, today());
    const kind = req.body.kind === "tulu" ? "tulu" : "kulu";
    // The dropdown's list is a suggestion, not a whitelist: picking "Muu" lets
    // the operator name the category, and that name has to reach the book.
    const category = text(req.body.category, 60).replace(/\s+/g, " ") || "Muu";
    const cash = moneyOr0(req.body.cash, "sularaha summa");
    const card = moneyOr0(req.body.card, "kaardi summa");
    const bank = moneyOr0(req.body.bank, "ülekande summa");
    if (cents(cash) + cents(card) + cents(bank) === 0) {
      return res.status(400).json({ error: "Sisesta summa sularaha, kaardi või ülekande lahtrisse." });
    }
    const entry = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO ledger_entries (user_id, entry_date, kind, category, description, cash, card, bank)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.shopId, when, kind, category, text(req.body.description, 300), cash, card, bank]
      );
      return r.rows[0];
    });
    await sendState(req, res, { entry }, 201);
  })
);

// Only entries typed in by hand. Removing one used to leave no trace at all;
// now it leaves an audit row with what it said and how much it was.
router.delete(
  "/ledger/:id",
  areaOnly("cash"),
  wrap(async (req, res) => {
    const entryId = paramId(req);
    await withTransaction(async (client) => {
      const r = await client.query(
        "SELECT * FROM ledger_entries WHERE id = $2 AND user_id = $1 FOR UPDATE",
        [req.shopId, entryId]
      );
      const e = r.rows[0];
      if (!e) throw httpError(404, "Kannet ei leitud.");
      if (e.invoice_id) throw httpError(409, "See kanne kuulub arve juurde ja seda ei saa eraldi kustutada.");
      await client.query("DELETE FROM ledger_entries WHERE id = $2 AND user_id = $1", [req.shopId, entryId]);
      const sum = (Number(e.cash) + Number(e.card) + Number(e.bank)).toFixed(2);
      await audit(client, req.shopId, req.userId, "kassakanne kustutatud", null,
        String(e.entry_date).slice(0, 10) + " · " + e.kind + " · " + e.category +
          (e.description ? " · " + e.description : "") + " · " + sum + " €");
    });
    await sendState(req, res, { ok: true });
  })
);

module.exports = router;
