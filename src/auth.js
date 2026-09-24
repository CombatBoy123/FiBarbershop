// auth.js — password hashing, JWT signing, and the middlewares every
// protected route is built from: who is signed in, and what they may do.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("./config");
const { query } = require("./db");

const TOKEN_TTL = "30d";

// The two roles the shop actually has. 'raamatupidaja' is deliberately absent:
// the column allows it, but nothing grants it until there is someone to be it.
const ROLES = ["omanik", "barber"];

// The parts of the app that can be handed out per account. Most keys match a
// nav tab, so a permission and the screen it opens share one name. `void` is
// not a screen: it is cancelling and deleting issued invoices under Arved.
const AREAS = ["cust", "price", "cash", "stock", "admin", "void"];

const AREA_LABEL = {
  cust: "Kliendid",
  price: "Hinnakiri",
  cash: "Kassaraamat",
  stock: "Ladu",
  admin: "Kontod",
  void: "Arvete kustutamine",
};

// What a barber gets on an account nobody has configured. Kliendid stays on
// because barbers already had it before these switches existed — defaulting it
// off would have silently changed how the shop works. Cancelling and deleting
// invoices is on because the shop wants every barber able to take back a sale
// they rang up wrong; the owner can switch it off per account.
const DEFAULT_PERMS = { cust: true, price: false, cash: false, stock: false, admin: false, void: true };

// An owner always has everything: the switches describe what a barber may
// reach, and an owner who could be locked out of their own books would be a
// footgun rather than a feature.
function canArea(user, area) {
  if (!user) return false;
  if (user.role === "omanik") return true;
  const granted = user.permissions || {};
  if (Object.prototype.hasOwnProperty.call(granted, area)) return Boolean(granted[area]);
  return Boolean(DEFAULT_PERMS[area]);
}

// Whatever arrives in the request body, what lands in the column is a clean
// map of the known keys as real booleans.
//
// Only the switches the request names are changed; the rest keep what the
// account already had (or the default). A page loaded before a switch existed
// sends a map without it, and that must not quietly turn the switch off —
// which is how a barber lost "Arvete kustutamine" when Kliendid was ticked
// from a tab still running the previous version.
function cleanPermissions(input, current) {
  const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
  const out = {};
  for (const area of AREAS) {
    out[area] = has(input, area) ? Boolean(input[area])
      : has(current, area) ? Boolean(current[area])
      : Boolean(DEFAULT_PERMS[area]);
  }
  return out;
}

const hashPassword = (plain) => bcrypt.hash(plain, 12);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the email matches no account, so a wrong email takes
// as long to refuse as a wrong password and the response time does not reveal
// which addresses have accounts.
const DUMMY_HASH = bcrypt.hashSync("fi-barbershop-no-such-account", 12);
const burnPasswordCheck = (plain) => bcrypt.compare(String(plain || ""), DUMMY_HASH);

// `at` is the signing moment in milliseconds. The standard `iat` is whole
// seconds, which would let a token minted in the same second as a password
// reset survive it.
function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, at: Date.now() }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// A token signed before the account's password last changed is dead. Tokens
// from before this rework carry only `iat`; they are judged by that.
function tokenRevoked(payload, pwChangedAt) {
  if (!pwChangedAt) return false;
  const signedAt = payload.at !== undefined ? Number(payload.at) : Number(payload.iat || 0) * 1000;
  return signedAt < new Date(pwChangedAt).getTime();
}

// Reads "Authorization: Bearer <token>" and then loads the account row.
//
// The row is read on every request rather than trusted from the token, because
// the token lives for 30 days: an owner who demotes a barber, switches an
// account off or resets its password needs that to take effect now.
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
      "SELECT id, email, name, shop_id, role, active, permissions, pw_changed_at FROM users WHERE id = $1",
      [payload.sub]
    );
    const user = r.rows[0];
    if (!user || tokenRevoked(payload, user.pw_changed_at)) {
      return res.status(401).json({ error: "Sessioon aegus. Palun logi uuesti sisse." });
    }
    if (!user.active) {
      return res.status(403).json({ error: "See konto on suletud. Võta ühendust salongi omanikuga." });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    req.userName = user.name;
    req.shopId = user.shop_id || user.id;
    req.role = user.role;
    req.permissions = user.permissions || {};
    req.can = (area) => canArea(user, area);
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

// Gate a route by one of the switchable areas. Same rule as requireRole.
const requirePerm = (area) => (req, res, next) =>
  req.can && req.can(area)
    ? next()
    : res.status(403).json({
        error: (AREA_LABEL[area] || "See osa") + " ei ole sinu kontole lubatud. Küsi omanikult.",
      });

// Owner-only, and not switchable. Everything behind this either moves money
// that has already been booked or hands out access. Making these grantable
// would let an account the owner meant to limit quietly promote itself.
const ownerOnly = [requireAuth, requireRole("omanik")];

// Gated by a switch the owner can flip per account, under Kontod.
const areaOnly = (area) => [requireAuth, requirePerm(area)];

module.exports = {
  ROLES,
  AREAS,
  AREA_LABEL,
  DEFAULT_PERMS,
  canArea,
  cleanPermissions,
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  signToken,
  verifyToken,
  tokenRevoked,
  requireAuth,
  requireRole,
  requirePerm,
  ownerOnly,
  areaOnly,
};
