// routes/customers.js — regulars and the prices agreed with them.
//
// Those prices are only a default the till fills in: the invoice line still
// stores its own copy, so changing a customer's price never rewrites an
// invoice already issued.

const express = require("express");

const { query, withTransaction } = require("../db");
const { areaOnly } = require("../auth");
const { wrap, httpError, money, paramId, text } = require("../lib/http");
const { sendState } = require("../state");

const router = express.Router();

router.post(
  "/customers",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const name = text(req.body.name, 200);
    if (!name) return res.status(400).json({ error: "Kliendi nimi puudub." });
    const r = await query(
      "INSERT INTO customers (user_id, name, details, note) VALUES ($1,$2,$3,$4) RETURNING *",
      [req.shopId, name, text(req.body.details, 500), text(req.body.note, 300)]
    );
    await sendState(req, res, { customer: { ...r.rows[0], prices: {} } }, 201);
  })
);

router.put(
  "/customers/:id",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const name = req.body.name === undefined ? null : text(req.body.name, 200);
    if (name === "") return res.status(400).json({ error: "Kliendi nimi ei saa olla tühi." });
    const r = await query(
      `UPDATE customers SET name = COALESCE($3, name), details = COALESCE($4, details),
              note = COALESCE($5, note)
        WHERE id = $2 AND user_id = $1 AND active RETURNING *`,
      [
        req.shopId, paramId(req), name,
        req.body.details === undefined ? null : text(req.body.details, 500),
        req.body.note === undefined ? null : text(req.body.note, 300),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Klienti ei leitud." });
    await sendState(req, res, { customer: r.rows[0] });
  })
);

// Set or clear one agreed price. An empty price removes the agreement rather
// than storing a zero, which would mean "free".
router.put(
  "/customers/:id/prices/:serviceId",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const customerId = paramId(req);
    const serviceId = paramId(req, "serviceId");
    const clearing = req.body.price === null || req.body.price === "" || req.body.price === undefined;
    const price = clearing ? null : money(req.body.price, "erihind");

    await withTransaction(async (client) => {
      const owned = await client.query(
        "SELECT id FROM customers WHERE id = $2 AND user_id = $1 AND active", [req.shopId, customerId]
      );
      if (!owned.rowCount) throw httpError(404, "Klienti ei leitud.");
      const svc = await client.query("SELECT id FROM services WHERE id = $2 AND user_id = $1", [req.shopId, serviceId]);
      if (!svc.rowCount) throw httpError(404, "Teenust ei leitud.");

      if (clearing) {
        await client.query("DELETE FROM customer_prices WHERE customer_id = $1 AND service_id = $2", [customerId, serviceId]);
      } else {
        await client.query(
          `INSERT INTO customer_prices (customer_id, service_id, price) VALUES ($1,$2,$3)
           ON CONFLICT (customer_id, service_id) DO UPDATE SET price = EXCLUDED.price`,
          [customerId, serviceId, price]
        );
      }
    });
    await sendState(req, res, { ok: true });
  })
);

router.delete(
  "/customers/:id",
  areaOnly("cust"),
  wrap(async (req, res) => {
    const r = await query(
      "UPDATE customers SET active = false WHERE id = $2 AND user_id = $1 AND active RETURNING id",
      [req.shopId, paramId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Klienti ei leitud." });
    await sendState(req, res, { ok: true });
  })
);

module.exports = router;
