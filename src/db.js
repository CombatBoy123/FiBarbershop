// db.js — the Postgres pool and the two ways of using it: a plain query, and
// a transaction that rolls back on any throw. The schema itself lives in
// migrations.js and is brought up to date once, before the server listens.

const { Pool, types } = require("pg");
const { DATABASE_URL } = require("./config");

// pg's default DATE parser returns a JS Date at local midnight in the server
// process's timezone, so a round trip through JSON can shift the date by a day
// whenever that timezone isn't UTC. DATE columns are date-only values with no
// timezone concept — parse them as plain 'YYYY-MM-DD' strings instead.
types.setTypeParser(1082, (val) => val);

// NUMERIC arrives as a string by default. Every amount in this app is euros
// with two decimals and well under 2^53 cents, so a Number is exact enough to
// display. Arithmetic on the server is still done in integer cents (see
// `cents` below) — this parser is for reading values out, not for summing.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const useSSL = /render\.com|sslmode=require/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Every amount crossing this app is euros with two decimals. Summing floats
// drifts (0.1 + 0.2), so all server-side arithmetic happens in integer cents
// and converts back once at the end.
const cents = (v) => Math.round(Number(v || 0) * 100);
const euros = (c) => Math.round(c) / 100;

const query = (text, params) => pool.query(text, params);

// Runs fn inside a transaction, rolling back on any throw. Used wherever an
// invoice, a cash-book entry and stock movements must land together or not
// at all.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, cents, euros };
