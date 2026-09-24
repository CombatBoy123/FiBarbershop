// routes/barbers.js — the people who cut hair, and what each of them charges.
//
// A barber is the chair, not the login: a guest barber may never have an
// account, and the shop has more barbers than accounts. account_id optionally
// ties a chair to a login, which is what shows that person their own prices
// and locks the till to their name.

const express = require("express");

const { withTransaction } = require("../db");
const { areaOnly } = require("../auth");
const { wrap, httpError, money, optionalId, paramId, text } = require("../lib/http");
const { sendState } = require("../state");

const router = express.Router();

const slugOf = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    .slice(0, 40) || "barber";

async function getBarber(client, shopId, barberId) {
  const r = await client.query(
    "SELECT * FROM barbers WHERE id = $2 AND user_id = $1 AND active FOR UPDATE",
    [shopId, barberId]
  );
  if (!r.rowCount) throw httpError(404, "Barberit ei leitud.");
  return r.rows[0];
}

router.post(
  "/barbers",
  areaOnly("price"),
  wrap(async (req, res) => {
    const name = text(req.body.name, 120);
    if (!name) return res.status(400).json({ error: "Barberi nimi puudub." });
    const slug = slugOf(req.body.slug || name);

    const barber = await withTransaction(async (client) => {
      // A removed barber keeps their slug, so re-adding someone by the same
      // name brings the old row back rather than failing on the unique key.
      const old = await client.query("SELECT id, active FROM barbers WHERE user_id = $1 AND slug = $2", [
        req.shopId, slug,
      ]);
      if (old.rowCount && old.rows[0].active) throw httpError(409, "Selle nimega barber on juba olemas.");

      const r = old.rowCount
        ? await client.query(
            `UPDATE barbers SET name = $3, tier = $4, phone = $5, active = true
              WHERE id = $2 AND user_id = $1 RETURNING *`,
            [req.shopId, old.rows[0].id, name, text(req.body.tier, 60), text(req.body.phone, 40)]
          )
        : await client.query(
            `INSERT INTO barbers (user_id, slug, name, tier, phone, sort_order)
             VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort_order)+1,0) FROM barbers WHERE user_id=$1))
             RETURNING *`,
            [req.shopId, slug, name, text(req.body.tier, 60), text(req.body.phone, 40)]
          );

      // A new barber starts on the shop's own price list rather than on
      // nothing, so the till has a number to put on a line from the first sale.
      await client.query(
        `INSERT INTO barber_prices (barber_id, service_id, price, offered)
         SELECT $2, s.id, s.price, true FROM services s WHERE s.user_id = $1 AND s.active
         ON CONFLICT (barber_id, service_id) DO NOTHING`,
        [req.shopId, r.rows[0].id]
      );
      return r.rows[0];
    });
    await sendState(req, res, { barber }, 201);
  })
);

router.put(
  "/barbers/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const barberId = paramId(req);
    const name = req.body.name === undefined ? null : text(req.body.name, 120);
    if (name === "") return res.status(400).json({ error: "Barberi nimi ei saa olla tühi." });
    const linking = req.body.accountId !== undefined;
    const accountId = linking ? optionalId(req.body.accountId, "konto") : null;

    const barber = await withTransaction(async (client) => {
      await getBarber(client, req.shopId, barberId);
      if (accountId) {
        // The account has to belong to this shop — otherwise one shop could
        // point a chair at another's login.
        const u = await client.query("SELECT id FROM users WHERE id = $2 AND shop_id = $1", [req.shopId, accountId]);
        if (!u.rowCount) throw httpError(404, "Kontot ei leitud.");
        // One login, one chair.
        await client.query("UPDATE barbers SET account_id = NULL WHERE user_id = $1 AND account_id = $2", [
          req.shopId, accountId,
        ]);
      }
      const r = await client.query(
        `UPDATE barbers SET name = COALESCE($3, name), tier = COALESCE($4, tier),
                phone = COALESCE($5, phone),
                account_id = CASE WHEN $6::boolean THEN $7 ELSE account_id END
          WHERE id = $2 AND user_id = $1 RETURNING *`,
        [
          req.shopId, barberId, name,
          req.body.tier === undefined ? null : text(req.body.tier, 60),
          req.body.phone === undefined ? null : text(req.body.phone, 40),
          linking, accountId,
        ]
      );
      return r.rows[0];
    });
    await sendState(req, res, { barber });
  })
);

// One barber's price for one service, and whether they perform it at all.
router.put(
  "/barbers/:id/prices/:serviceId",
  areaOnly("price"),
  wrap(async (req, res) => {
    const barberId = paramId(req);
    const serviceId = paramId(req, "serviceId");
    const offered = req.body.offered === undefined ? true : Boolean(req.body.offered);
    const price = money(req.body.price === undefined ? 0 : req.body.price, "hind");

    await withTransaction(async (client) => {
      await getBarber(client, req.shopId, barberId);
      const svc = await client.query("SELECT id FROM services WHERE id = $2 AND user_id = $1", [req.shopId, serviceId]);
      if (!svc.rowCount) throw httpError(404, "Teenust ei leitud.");
      await client.query(
        `INSERT INTO barber_prices (barber_id, service_id, price, offered) VALUES ($1,$2,$3,$4)
         ON CONFLICT (barber_id, service_id)
         DO UPDATE SET price = EXCLUDED.price, offered = EXCLUDED.offered`,
        [barberId, serviceId, price, offered]
      );
    });
    await sendState(req, res, { ok: true });
  })
);

// Soft delete: past invoice lines point at the barber, and the monthly
// summary must still be able to name them. Their login link is dropped, so
// the account is no longer locked to a chair that is gone.
router.delete(
  "/barbers/:id",
  areaOnly("price"),
  wrap(async (req, res) => {
    const barberId = paramId(req);
    await withTransaction(async (client) => {
      await getBarber(client, req.shopId, barberId);
      await client.query(
        "UPDATE barbers SET active = false, account_id = NULL WHERE id = $2 AND user_id = $1",
        [req.shopId, barberId]
      );
    });
    await sendState(req, res, { ok: true });
  })
);

module.exports = router;
