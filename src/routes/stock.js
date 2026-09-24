// routes/stock.js — ladu: goods booked in, written off, and counted.
//
// Stock is never stored as a number. It is the sum of the movements, so every
// change here is a movement and the history always explains the figure.

const express = require("express");

const { withTransaction } = require("../db");
const { areaOnly } = require("../auth");
const { wrap, httpError, moneyOr0, number, id, paramId, date } = require("../lib/http");
const { today } = require("../lib/dates");
const { reserveStock, stockOf, audit } = require("../lib/invoicing");
const { sendState } = require("../state");

const router = express.Router();

// Locks one product row for the rest of the transaction. Every path that
// changes a product's stock takes this lock (sales via reserveStock), so two
// people correcting or selling the same item are served one at a time.
async function lockProduct(client, shopId, productId) {
  const p = await client.query(
    "SELECT id, name, cost FROM products WHERE id = $2 AND user_id = $1 FOR UPDATE",
    [shopId, productId]
  );
  if (!p.rowCount) throw httpError(404, "Toodet ei leitud.");
  return p.rows[0];
}

// Set the stock of one product outright (a stocktake). This does not overwrite
// a number — it books the difference as one correcting movement.
router.put(
  "/products/:id/stock",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const productId = paramId(req);
    const target = number(req.body.qty, { min: 0, max: 1000000, label: "kogus" });
    const when = date(req.body.date, today());

    const delta = await withTransaction(async (client) => {
      const product = await lockProduct(client, req.shopId, productId);
      const have = (await stockOf(client, req.shopId, [productId])).get(productId) || 0;
      const diff = Math.round((target - have) * 1000) / 1000;
      if (diff === 0) return 0;
      await client.query(
        `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.shopId, productId, when, diff > 0 ? "in" : "out", Math.abs(diff), Number(product.cost) || 0]
      );
      await audit(client, req.shopId, req.userId, "inventuur", null,
        product.name + " · " + have + " → " + target + " tk");
      return diff;
    });

    await sendState(req, res, { delta });
  })
);

router.post(
  "/stock-movements",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const productId = id(req.body.productId, "toode");
    const type = req.body.type === "out" ? "out" : "in";
    const qty = number(req.body.qty, { min: 0.001, max: 1000000, label: "kogus" });
    const price = moneyOr0(req.body.price, "ühiku hind");
    const when = date(req.body.date, today());

    const movement = await withTransaction(async (client) => {
      const product = await lockProduct(client, req.shopId, productId);
      // A write-off cannot take more than the shelf holds — same check, and
      // the same lock, as a sale.
      if (type === "out") await reserveStock(client, req.shopId, [{ productId, qty }]);
      const r = await client.query(
        `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.shopId, productId, when, type, qty, price]
      );
      return { ...r.rows[0], product_name: product.name };
    });
    await sendState(req, res, { movement }, 201);
  })
);

// A movement that came from a sale belongs to its invoice: cancelling the
// invoice is how it goes away. Anything booked by hand can be removed, and
// the removal is written to the audit trail — it changes what the shelf is
// worth.
router.delete(
  "/stock-movements/:id",
  areaOnly("stock"),
  wrap(async (req, res) => {
    const moveId = paramId(req);
    await withTransaction(async (client) => {
      const r = await client.query(
        `SELECT m.*, p.name AS product_name FROM stock_movements m
           JOIN products p ON p.id = m.product_id
          WHERE m.id = $2 AND m.user_id = $1`,
        [req.shopId, moveId]
      );
      const m = r.rows[0];
      if (!m) throw httpError(404, "Liikumist ei leitud.");
      if (m.invoice_id) throw httpError(409, "See liikumine tuli müügist ja seda ei saa eraldi kustutada.");
      await lockProduct(client, req.shopId, m.product_id);
      // Removing an incoming delivery can leave the shelf below zero when
      // some of it has already been sold. Refuse that rather than book a
      // negative stock the till would then believe.
      if (m.move_type === "in") {
        const have = (await stockOf(client, req.shopId, [m.product_id])).get(m.product_id) || 0;
        if (Math.round((have - Number(m.qty)) * 1000) < 0) {
          throw httpError(409, m.product_name + " — osa sellest kaubast on juba müüdud. Tee parandus inventuuriga.");
        }
      }
      await client.query("DELETE FROM stock_movements WHERE id = $2 AND user_id = $1", [req.shopId, moveId]);
      await audit(client, req.shopId, req.userId, "laoliikumine kustutatud", null,
        m.product_name + " · " + (m.move_type === "in" ? "sisse " : "välja ") + Number(m.qty) + " tk · " +
          String(m.move_date).slice(0, 10));
    });
    await sendState(req, res, { ok: true });
  })
);

module.exports = router;
