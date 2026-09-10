// auth.js — password hashing, JWT signing, and the two middlewares every
// protected route is built from: who is signed in, and what they may do.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { query } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Copy .env.example to .env and set a long random JWT_SECRET before starting the server."
  );
}
const TOKEN_TTL = "30d";

// The two roles the shop actually has. 'raamatupidaja' is deliberately absent:
// the column allows it, but nothing grants it until there is someone to be it.
const ROLES = ["omanik", "barber"];

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Reads "Authorization: Bearer <token>" and then loads the account row.
//
// The row is read on every request rather than trusted from the token, because
// the token lives for 30 days: an owner who demotes a barber or switches an
// account off needs that to take effect now, not in a month.
//
// Two different ids come out of this and the difference is the whole design:
//   req.userId — WHO is acting. Audit trail, created_by. Never scopes data.
//   req.shopId — WHOSE books these are. Every data query uses this one.
// For the owner they are the same number; for a barber they are not.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token && verifyToken(token);
    if (!payload) return res.status(401).json({ error: "Palun logi sisse." });

    const r = await query(
      "SELECT id, email, name, shop_id, role, active FROM users WHERE id = $1",
      [payload.sub]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Palun logi sisse." });
    if (!user.active) {
      return res.status(403).json({ error: "See konto on suletud. Võta ühendust salongi omanikuga." });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    req.userName = user.name;
    req.shopId = user.shop_id || user.id;
    req.role = user.role;
    next();
  } catch (err) {
    next(err);
  }
}

// Gate a route by role. Belongs on the route, not inside the handler: a check
// that lives in the middleware chain cannot be forgotten halfway down a
// function. The client also hides these buttons, but that is only courtesy —
// this is the part that actually decides.
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.role)
    ? next()
    : res.status(403).json({ error: "Selleks toiminguks pole sul õigust." });

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
};
