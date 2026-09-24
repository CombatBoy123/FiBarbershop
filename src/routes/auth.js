// routes/auth.js — logging in, the session's own account, and the bootstrap
// call that hands the signed-in till its whole state.

const express = require("express");

const { ALLOW_PUBLIC_REGISTER } = require("../config");
const { query, withTransaction } = require("../db");
const {
  hashPassword, verifyPassword, burnPasswordCheck, signToken, requireAuth,
} = require("../auth");
const { seedDefaults } = require("../seed");
const { wrap, isEmail, text } = require("../lib/http");
const { loadState, describeMe } = require("../state");

const router = express.Router();

// ------------------------------------------------------- brute-force guard

// A handful of failures per email locks that email out for a few minutes, and
// a generous per-IP ceiling stops password-spraying (many emails, a few tries
// each) from one source. In-memory, so it resets on deploy — fine for a single
// shop's till. The sweep keeps both maps from growing without bound.
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;
const IP_MAX = 40;

const failures = new Map();
const ipHits = new Map();

const fresh = (rec) => rec && Date.now() - rec.at <= LOCK_MS;

function bump(map, key) {
  const rec = map.get(key);
  if (fresh(rec)) rec.n += 1;
  else map.set(key, { n: 1, at: Date.now() });
}

const blocked = (map, key, max) => {
  const rec = map.get(key);
  return Boolean(fresh(rec) && rec.n >= max);
};

setInterval(() => {
  for (const map of [failures, ipHits]) {
    for (const [key, rec] of map) if (!fresh(rec)) map.delete(key);
  }
}, LOCK_MS).unref();

const TOO_MANY = { error: "Liiga palju katseid. Proovi mõne minuti pärast uuesti." };

// ------------------------------------------------------------------ routes

router.post(
  "/register",
  wrap(async (req, res) => {
    if (!ALLOW_PUBLIC_REGISTER) {
      return res.status(403).json({ error: "Registreerimine on suletud. Konto loob salongi omanik." });
    }
    const email = text(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || "");
    const name = text(req.body.name, 120);
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
      // is never created here — the owner adds those under Kontod.
      await client.query("UPDATE users SET shop_id = id WHERE id = $1", [r.rows[0].id]);
      await seedDefaults(client, r.rows[0].id);
      return r.rows[0];
    });

    res.status(201).json({ token: signToken(user), user });
  })
);

router.post(
  "/login",
  wrap(async (req, res) => {
    const ip = req.ip || "?";
    if (blocked(ipHits, ip, IP_MAX)) return res.status(429).json(TOO_MANY);
    bump(ipHits, ip);

    const email = text(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || "");
    if (blocked(failures, email, LOCK_AFTER)) return res.status(429).json(TOO_MANY);

    const r = await query(
      "SELECT id, email, name, password_hash, role, active FROM users WHERE email = $1",
      [email]
    );
    const user = r.rows[0];
    const good = user ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);
    if (!user || !good) {
      bump(failures, email);
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

router.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: { id: req.userId, email: req.userEmail, name: req.userName, role: req.role } });
  })
);

// The whole till, as the top-level object (every write answers with the same
// thing under `state`).
router.get(
  "/bootstrap",
  requireAuth,
  wrap(async (req, res) => {
    const state = await loadState(req.shopId);
    state.me = describeMe(req);
    res.json(state);
  })
);

// Change your own. The current one is required, so a walk-up at an unlocked
// till cannot lock the owner out of their own shop. Every other session of
// this account ends; this one gets a fresh token so it carries on.
router.put(
  "/me/password",
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body.current || "");
    const next = String(req.body.password || "");
    if (next.length < 8) {
      return res.status(400).json({ error: "Uus parool peab olema vähemalt 8 tähemärki." });
    }
    const u = await query("SELECT password_hash FROM users WHERE id = $1", [req.userId]);
    if (!u.rowCount || !(await verifyPassword(current, u.rows[0].password_hash))) {
      // 400, not 401: the session is fine, only the typed password is wrong —
      // a 401 would make the client sign the person out.
      return res.status(400).json({ error: "Praegune parool ei klapi." });
    }
    await query("UPDATE users SET password_hash = $2, pw_changed_at = $3 WHERE id = $1", [
      req.userId, await hashPassword(next), new Date(),
    ]);
    res.json({ ok: true, token: signToken({ id: req.userId, email: req.userEmail }) });
  })
);

module.exports = router;
