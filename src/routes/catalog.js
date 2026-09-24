// routes/catalog.js — what the shop sells and on what terms: invoice
// settings, the service price list and the retail products.

const express = require("express");

const { query, withTransaction } = require("../db");
const { areaOnly } = require("../auth");
const {
  wrap, httpError, money, number, paramId, text, textOrNull,
} = require("../lib/http");
const { sendState } = require("../state");

const router = express.Router();

// ---------------------------------------------------------------- settings

// Each field with the parser that makes it safe to store. A VAT rate of -5 or
// a payment term of ten years is refused instead of quietly printed on every
// invoice from then on.
const SETTING_FIELDS = {
  vat_rate: (v) => number(v, { min: 0, max: 100, decimals: 2, label: "KM määr" }),
  opening_balance: (v) => number(v, { min: -1000000, max: 1000000, decimals: 2, label: "algsaldo" }),
  low_stock: (v) => number(v, { min: 0, max: 100000, decimals: 0, label: "madala jäägi piir" }),
  payment_days: (v) => number(v, { min: 0, max: 365, decimals: 0, label: "maksetähtaeg" }),
  show_vat: (v) => Boolean(v),
  ask_tip: (v) => Boolean(v),
  company_name: (v) => text(v, 200),
  company_address: (v) => text(v, 300),
  company_reg: (v) => text(v, 40),
  company_kmkr: (v) => text(v, 40),
  company_bank: (v) => text(v, 100),
  company_iban: (v) => text(v, 60).replace(/\s+/g, " ").toUpperCase(),
  company_phone: (v) => text(v, 60),
  company_email: (v) => text(v, 200),
  company_web: (v) => text(v, 200),
};

router.put(
  "/settings",
  areaOnly("price"),
  wrap(async (req, res) => {
    const sets = [];
    const vals = [req.shopId];
    for (const [field, parse] of Object.entries(SETTING_FIELDS)) {
      if (!(field in req.body)) continue;
      vals.push(parse(req.body[field]));
      sets.push(field + " = $" + vals.length);
    }
    if (!sets.length) return res.status(400).json({ error: "Midagi ei muudetud." });
    await query("UPDATE settings SET " + sets.join(", ") + " WHERE user_id = $1", vals);
    await sendState(req, res);
  })
);

// ---------------------------------------------------------------- services

router.post(
  "/services",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = text(req.body.name, 200);
    if (!name) return res.status(400).json({ error: "Teenuse nimi puudub." });
    const price = money(req.body.price, "hind");

    const service = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO services (user_id, name, price, note, sort_order)
         VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order)+1,0) FROM services WHERE user_id=$1))
         RETURNING *`,
        [req.shopId, name, price, text(req.body.note, 200)]
      );
      // Every barber offers a new service at the shop's price until someone
      // says otherwise under Hinnakiri. Without these rows the service would
      // read as "not offered" by everyone and could not be rung up at all.
      await client.query(
        `INSERT INTO barber_prices (barber_id, service_id, price, offered)
         SELECT b.id, $2, $3, true FROM barbers b WHERE b.user_id = $1 AND b.active
         ON CONFLICT (barber_id, service_id) DO NOTHING`,
        [req.shopId, r.rows[0].id, price]
      );
      return r.rows[0];
    });
    await sendState(req, res, { service }, 201);
  })
);

router.put(
  "/services/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = textOrNull(req.body.name, 200);
    if (name === "") return res.status(400).json({ error: "Teenuse nimi ei saa olla tühi." });
    const r = await query(
      `UPDATE services SET name = COALESCE($3, name), price = COALESCE($4, price), note = COALESCE($5, note)
        WHERE id = $2 AND user_id = $1 AND active RETURNING *`,
      [
        req.shopId,
        paramId(req),
        name,
        req.body.price === undefined ? null : money(req.body.price, "hind"),
        textOrNull(req.body.note, 200),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    await sendState(req, res, { service: r.rows[0] });
  })
);

// Soft delete: past invoices keep the name they were sold under.
router.delete(
  "/services/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const r = await query(
      "UPDATE services SET active = false WHERE id = $2 AND user_id = $1 AND active RETURNING id",
      [req.shopId, paramId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Teenust ei leitud." });
    await sendState(req, res, { ok: true });
  })
);

// ---------------------------------------------------------------- products

// Product photos are served by this app (scripts/sync-products.js downloads
// them). A path under assets/ or an https address is accepted; anything else
// — a javascript: URL, a stray local path — is not stored.
function imageUrl(v) {
  const s = text(v, 500);
  if (!s) return "";
  if (/^assets\/[\w./-]+$/i.test(s) || /^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  throw httpError(400, "Pildi aadress peab algama assets/ või https:// .");
}

router.post(
  "/products",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = text(req.body.name, 200);
    if (!name) return res.status(400).json({ error: "Toote nimi puudub." });
    const r = await query(
      `INSERT INTO products (user_id, name, cost, price, image_url, sort_order)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort_order)+1,0) FROM products WHERE user_id=$1))
       RETURNING *`,
      [
        req.shopId, name,
        req.body.cost === undefined || req.body.cost === "" ? 0 : money(req.body.cost, "ostuhind"),
        money(req.body.price, "müügihind"),
        imageUrl(req.body.image_url),
      ]
    );
    await sendState(req, res, { product: { ...r.rows[0], stock: 0 } }, 201);
  })
);

router.put(
  "/products/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = textOrNull(req.body.name, 200);
    if (name === "") return res.status(400).json({ error: "Toote nimi ei saa olla tühi." });
    const r = await query(
      `UPDATE products SET name = COALESCE($3, name), cost = COALESCE($4, cost),
              price = COALESCE($5, price), image_url = COALESCE($6, image_url)
        WHERE id = $2 AND user_id = $1 AND active RETURNING *`,
      [
        req.shopId,
        paramId(req),
        name,
        req.body.cost === undefined ? null : money(req.body.cost, "ostuhind"),
        req.body.price === undefined ? null : money(req.body.price, "müügihind"),
        req.body.image_url === undefined ? null : imageUrl(req.body.image_url),
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });
    await sendState(req, res, { product: r.rows[0] });
  })
);

router.delete(
  "/products/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const r = await query(
      "UPDATE products SET active = false WHERE id = $2 AND user_id = $1 AND active RETURNING id",
      [req.shopId, paramId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Toodet ei leitud." });
    await sendState(req, res, { ok: true });
  })
);

module.exports = router;
