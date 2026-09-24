// dates.js — calendar dates in the shop's own timezone.
//
// Dates travel as 'YYYY-MM-DD' strings everywhere. The old server took
// "today" from toISOString(), which is UTC: between midnight and 03:00 in
// Tartu that is still yesterday, so a stocktake or a cash-book entry made
// after midnight landed on the wrong day.

// Read straight from the environment (config.js validates it) so these pure
// helpers can be loaded by unit tests without a database URL.
require("dotenv").config();
const TZ = process.env.SHOP_TZ || "Europe/Tallinn";

// en-CA formats as YYYY-MM-DD, which is exactly the wire format.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

const today = () => fmt.format(new Date());

// The shop-local calendar date of a timestamp, e.g. when an invoice was paid.
const localDate = (ts) => fmt.format(ts instanceof Date ? ts : new Date(ts));

// Format alone is not enough: '2026-02-31' matches the pattern and then
// fails inside Postgres as a 500. A real date survives the round trip.
function isValidDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function addDays(dateStr, days) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

module.exports = { TZ, today, localDate, isValidDate, addDays };
