// routes/staff.js — the logins that work for this shop, what each may open,
// and their passwords. Owner-only throughout: these hand out access.

const express = require("express");

const { withTransaction } = require("../db");
const { ROLES, AREAS, cleanPermissions, hashPassword, signToken, ownerOnly } = require("../auth");
const { wrap, httpError, isEmail, paramId, text } = require("../lib/http");
const { audit } = require("../lib/invoicing");
const { sendState } = require("../state");

const router = express.Router();

async function getStaff(client, shopId, staffId) {
  const r = await client.query(
    "SELECT id, email, name, role, active FROM users WHERE id = $2 AND shop_id = $1 FOR UPDATE",
    [shopId, staffId]
  );
  if (!r.rowCount) throw httpError(404, "Kontot ei leitud.");
  return r.rows[0];
}

// The account the shop was created with is what every data row points at.
// A second owner may manage everyone else, but not demote or close that one.
function assertNotFounder(req, target, what) {
  if (target.id === req.shopId && req.userId !== req.shopId) {
    throw httpError(409, "Salongi asutaja kontot ei saa " + what + ".");
  }
}

// Creating an account is how a barber gets a login. It points at the owner's
// shop, so it sees the same books rather than an empty till of its own.
router.post(
  "/staff",
  ownerOnly,
  wrap(async (req, res) => {
    const email = text(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || "");
    const name = text(req.body.name, 120);
    const role = ROLES.includes(req.body.role) ? req.body.role : "barber";
    if (!isEmail(email)) return res.status(400).json({ error: "Vigane e-posti aadress." });
    if (password.length < 8) return res.status(400).json({ error: "Parool peab olema vähemalt 8 tähemärki." });

    const user = await withTransaction(async (client) => {
      const exists = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      if (exists.rowCount) throw httpError(409, "Selle e-postiga konto on juba olemas.");
      const r = await client.query(
        `INSERT INTO users (email, password_hash, name, shop_id, role)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, active, created_at`,
        [email, await hashPassword(password), name || null, req.shopId, role]
      );
      await audit(client, req.shopId, req.userId, "konto loodud", null, email + " · " + role);
      return r.rows[0];
    });

    await sendState(req, res, { user }, 201);
  })
);

// Name, role, open/closed. The owner cannot demote or close themselves — the
// shop must keep someone who can undo a mistake.
router.put(
  "/staff/:id",
  ownerOnly,
  wrap(async (req, res) => {
    const staffId = paramId(req);
    const role = req.body.role === undefined ? null : req.body.role;
    if (role !== null && !ROLES.includes(role)) return res.status(400).json({ error: "Tundmatu roll." });
    const active = req.body.active === undefined ? null : Boolean(req.body.active);
    const name = req.body.name === undefined ? null : text(req.body.name, 120);

    const user = await withTransaction(async (client) => {
      const cur = await getStaff(client, req.shopId, staffId);
      const demoting = role === "barber" && cur.role !== "barber";
      if (staffId === req.userId && (demoting || active === false)) {
        throw httpError(409, "Iseenda õigusi ei saa ära võtta.");
      }
      if (demoting) assertNotFounder(req, cur, "alandada");
      if (active === false) assertNotFounder(req, cur, "sulgeda");

      const r = await client.query(
        `UPDATE users SET role = COALESCE($3, role), active = COALESCE($4, active),
                name = COALESCE($5, name),
                pw_changed_at = CASE WHEN $4 = false THEN $6 ELSE pw_changed_at END
          WHERE id = $2 AND shop_id = $1
          RETURNING id, email, name, role, active, created_at`,
        [req.shopId, staffId, role, active, name, new Date()]
      );
      const changes = [
        role && role !== cur.role ? "roll " + cur.role + " → " + role : null,
        active !== null && active !== cur.active ? (active ? "taasavatud" : "suletud") : null,
      ].filter(Boolean);
      if (changes.length) {
        await audit(client, req.shopId, req.userId, "konto muudetud", null, cur.email + " · " + changes.join(", "));
      }
      return r.rows[0];
    });
    await sendState(req, res, { user });
  })
);

// Which parts of the app this account may open. Refused on an owner's row:
// an owner always has everything.
router.put(
  "/staff/:id/permissions",
  ownerOnly,
  wrap(async (req, res) => {
    const staffId = paramId(req);
    const perms = cleanPermissions(req.body.permissions);
    const user = await withTransaction(async (client) => {
      const cur = await getStaff(client, req.shopId, staffId);
      if (cur.role === "omanik") {
        throw httpError(409, "Omanikul on alati kõik õigused. Piiramiseks muuda roll enne barberiks.");
      }
      const r = await client.query(
        `UPDATE users SET permissions = $3 WHERE id = $2 AND shop_id = $1
         RETURNING id, email, name, role, active, permissions, created_at`,
        [req.shopId, staffId, JSON.stringify(perms)]
      );
      await audit(client, req.shopId, req.userId, "õigused muudetud", null,
        cur.email + " · " + (AREAS.filter((a) => perms[a]).join(", ") || "ei midagi"));
      return r.rows[0];
    });
    await sendState(req, res, { user });
  })
);

// Switched off, never deleted: invoices point at their creator, and a barber
// who leaves should not erase who rang up last year's sales.
router.delete(
  "/staff/:id",
  ownerOnly,
  wrap(async (req, res) => {
    const staffId = paramId(req);
    if (staffId === req.userId) return res.status(409).json({ error: "Iseennast ei saa sulgeda." });
    await withTransaction(async (client) => {
      const cur = await getStaff(client, req.shopId, staffId);
      assertNotFounder(req, cur, "sulgeda");
      await client.query(
        "UPDATE users SET active = false, pw_changed_at = $3 WHERE id = $2 AND shop_id = $1",
        [req.shopId, staffId, new Date()]
      );
      await audit(client, req.shopId, req.userId, "konto muudetud", null, cur.email + " · suletud");
    });
    await sendState(req, res, { ok: true });
  })
);

// For the barber who has forgotten theirs. The owner never learns the old one
// — it is replaced, not revealed — and every session on the old one ends.
router.put(
  "/staff/:id/password",
  ownerOnly,
  wrap(async (req, res) => {
    const staffId = paramId(req);
    const next = String(req.body.password || "");
    if (next.length < 8) return res.status(400).json({ error: "Parool peab olema vähemalt 8 tähemärki." });
    await withTransaction(async (client) => {
      const cur = await getStaff(client, req.shopId, staffId);
      await client.query(
        "UPDATE users SET password_hash = $3, pw_changed_at = $4 WHERE id = $2 AND shop_id = $1",
        [req.shopId, staffId, await hashPassword(next), new Date()]
      );
      await audit(client, req.shopId, req.userId, "parool lähtestatud", null, cur.email);
    });
    // Resetting your own ends your other sessions too, but not this one.
    const self = staffId === req.userId;
    await sendState(req, res, self ? { ok: true, token: signToken({ id: req.userId, email: req.userEmail }) } : { ok: true });
  })
);

module.exports = router;
