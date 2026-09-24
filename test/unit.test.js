// unit.test.js — the pure rules, no database needed.
//
//   npm run test:unit

const test = require("node:test");
const assert = require("node:assert/strict");

// config.js is not loaded by these modules, but dotenv may be; keep them
// independent of any real .env.
process.env.SHOP_TZ = process.env.SHOP_TZ || "Europe/Tallinn";

const { isValidDate, addDays, localDate } = require("../src/lib/dates");
const { money, number, id, date } = require("../src/lib/http");

// invoicing.js pulls in db.js for cents/euros, which needs config. Give it a
// harmless URL: nothing here opens a connection.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused@localhost/unused";
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret";
const { normaliseLines, lineCents, totals, referenceNumber } = require("../src/lib/invoicing");

test("isValidDate accepts real dates only", () => {
  assert.equal(isValidDate("2026-09-24"), true);
  assert.equal(isValidDate("2024-02-29"), true);
  assert.equal(isValidDate("2026-02-29"), false);
  assert.equal(isValidDate("2026-02-31"), false);
  assert.equal(isValidDate("2026-9-24"), false);
  assert.equal(isValidDate(""), false);
  assert.equal(isValidDate(null), false);
});

test("addDays crosses month and year ends", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-25", 14), "2027-01-08");
});

test("localDate uses the shop's timezone, not UTC", () => {
  // 23:30 UTC on the 24th is already the 25th in Tartu (UTC+3 in summer).
  assert.equal(localDate("2026-09-24T23:30:00Z"), "2026-09-25");
  assert.equal(localDate("2026-01-15T21:59:00Z"), "2026-01-15");
  assert.equal(localDate("2026-01-15T22:01:00Z"), "2026-01-16");
});

test("money refuses negatives and junk, rounds to the cent", () => {
  assert.equal(money("12.345"), 12.35);
  assert.equal(money(0), 0);
  assert.throws(() => money(-1), { status: 400 });
  assert.throws(() => money("abc"), { status: 400 });
  assert.throws(() => money(""), { status: 400 });
  assert.throws(() => money(2000000), { status: 400 });
});

test("number and id parsers", () => {
  assert.equal(number("2.5", { min: 0 }), 2.5);
  assert.throws(() => number("x"), { status: 400 });
  assert.equal(id("42"), 42);
  assert.throws(() => id("4.2"), { status: 400 });
  assert.throws(() => id("-1"), { status: 400 });
  assert.equal(date(undefined, "2026-01-01"), "2026-01-01");
  assert.throws(() => date("2026-13-01"), { status: 400 });
});

test("normaliseLines validates every field", () => {
  const [l] = normaliseLines([{ name: " Juukselõikus ", qty: "2", price: "35", discount: "10", unit: "kord" }]);
  assert.deepEqual(
    { name: l.name, qty: l.qty, price: l.price, discount: l.discount, unit: l.unit },
    { name: "Juukselõikus", qty: 2, price: 35, discount: 10, unit: "kord" }
  );
  assert.throws(() => normaliseLines([]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "", qty: 1 }]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "x", qty: 0 }]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "x", qty: "abc" }]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "x", price: -1 }]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "x", discount: 101 }]), { status: 400 });
  assert.throws(() => normaliseLines([{ name: "x", productId: "abc" }]), { status: 400 });
  assert.equal(normaliseLines([{ name: "x", unit: "kilo" }])[0].unit, "tk");
});

test("line totals and VAT are computed in cents", () => {
  assert.equal(lineCents({ price: 35, qty: 3, discount: 10 }), 9450);
  assert.equal(lineCents({ price: 0.1, qty: 3, discount: 0 }), 30);
  const t = totals([{ price: 35, qty: 1, discount: 0 }, { price: 12.4, qty: 1, discount: 0 }], 5, 24);
  assert.equal(t.total, 52.4);
  assert.equal(t.net + t.vat, 47.4); // the tip is outside the VAT base
  assert.equal(t.net, 38.23);
  const noVat = totals([{ price: 10, qty: 1, discount: 0 }], 0, 0);
  assert.deepEqual([noVat.net, noVat.vat], [10, 0]);
});

test("referenceNumber appends a valid 7-3-1 check digit", () => {
  // Worked example from the Estonian banking standard: 1234561 is valid.
  assert.equal(referenceNumber("123456"), "1234561");
  // 4·7 + 0·3 + 0·1 + 6·7 + 2·3 + 9·1 = 85 → check digit 5; the leading zero goes.
  assert.equal(referenceNumber("0926-004"), "9260045");
  assert.equal(referenceNumber(""), "");
  const valid = (r) => {
    const d = r.slice(0, -1), w = [7, 3, 1];
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += Number(d[d.length - 1 - i]) * w[i % 3];
    return (10 - (sum % 10)) % 10 === Number(r.slice(-1));
  };
  for (const nr of ["0126-001", "1226-999", "0526-1000"]) assert.ok(valid(referenceNumber(nr)), nr);
});
