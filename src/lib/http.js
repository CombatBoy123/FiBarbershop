// http.js — request plumbing shared by every route: error construction, the
// async wrapper, and the parsers that turn untrusted request fields into
// values the database can take.
//
// The parsers throw a 400 rather than guessing. The old code turned junk into
// 0 or 1 silently and let NaN through to Postgres, where it surfaced as a 500.

const { isValidDate } = require("./dates");

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Wraps an async route so a rejected promise becomes a handled error response
// instead of an unhandled rejection that silently kills the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// A barbershop price or cost is never negative and never approaches a million
// euros. Rounded to the cent on the way in, so 12.345 cannot be stored and
// then displayed as something other than what is summed.
const MAX_MONEY = 1000000;

function money(v, label = "summa") {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
    throw httpError(400, "Vigane " + label + ". Lubatud on 0–" + MAX_MONEY + " €.");
  }
  return Math.round(n * 100) / 100;
}

// Optional money: absent or empty means 0, anything present must be valid.
const moneyOr0 = (v, label) => (v === undefined || v === null || v === "" ? 0 : money(v, label));

function number(v, { min = -Infinity, max = Infinity, label = "arv", decimals = 3 } = {}) {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max) {
    throw httpError(400, "Vigane " + label + ".");
  }
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Row ids arrive from the URL and from line objects. Anything that is not a
// positive integer can never match a row, so it is refused up front.
function id(v, label = "id") {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw httpError(400, "Vigane " + label + ".");
  return n;
}

const optionalId = (v, label) => (v === undefined || v === null || v === "" || v === 0 ? null : id(v, label));

// For :id path parameters a bad value simply names nothing, hence 404.
function paramId(req, name = "id") {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw httpError(404, "Ei leitud.");
  return n;
}

const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

// undefined means "leave as is" in the PATCH-style updates; null is written
// by COALESCE as "keep the column".
const textOrNull = (v, max) => (v === undefined ? null : text(v, max));

function date(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (!isValidDate(v)) throw httpError(400, "Vigane kuupäev: " + String(v).slice(0, 20));
  return v;
}

module.exports = {
  httpError, wrap, isEmail, MAX_MONEY, money, moneyOr0, number, id, optionalId, paramId,
  text, textOrNull, date,
};
