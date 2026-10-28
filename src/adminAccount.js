// adminAccount.js — a way back in when nobody can log in.
//
// Render's free plan has no shell, so `npm run seed-user` cannot be run
// against the live database. Instead, ADMIN_EMAIL and ADMIN_PASSWORD set in
// the service's Environment settings make the server, as it starts, see to it
// that this owner account exists and opens with that password:
//
//   * an account with that email: it is made an active owner and, when the
//     password differs, gets this one — every other session of it ends;
//   * no such account, but the database has a shop: a new owner of that shop;
//   * an empty database (a brand-new one): a new shop with the default price
//     list, exactly as `npm run seed-user` would make it.
//
// The password lives in Render's settings and never in the repository, which
// is public. While the two variables are set, every restart puts this
// password back — so they are meant to be removed once you are in, and the
// server says so in its log each time it starts with them.

const { withTransaction } = require("./db");
const { hashPassword, verifyPassword } = require("./auth");
const { seedDefaults } = require("./seed");
const { isEmail } = require("./lib/http");
const { audit } = require("./lib/invoicing");

const SOURCE = "Renderi seadetest (ADMIN_EMAIL)";

async function ensureAdmin({ email, password, name, log = console.log } = {}) {
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  if (!email && !password) return null;
  if (!isEmail(email)) throw new Error("ADMIN_EMAIL ei ole kehtiv e-posti aadress.");
  if (password.length < 8) throw new Error("ADMIN_PASSWORD peab olema vähemalt 8 tähemärki.");
  name = String(name || "").trim().slice(0, 120) || null;

  const result = await withTransaction(async (client) => {
    const found = await client.query(
      "SELECT id, shop_id, role, active, password_hash FROM users WHERE email = $1 FOR UPDATE",
      [email]
    );

    if (found.rowCount) {
      const u = found.rows[0];
      const samePassword = await verifyPassword(password, u.password_hash);
      if (samePassword && u.role === "omanik" && u.active) return { action: "unchanged", shopId: u.shop_id };
      await client.query(
        `UPDATE users SET role = 'omanik', active = true,
                password_hash = $2,
                pw_changed_at = CASE WHEN $4 THEN pw_changed_at ELSE $3 END
          WHERE id = $1`,
        [u.id, samePassword ? u.password_hash : await hashPassword(password), new Date(), samePassword]
      );
      await audit(client, u.shop_id || u.id, null, "konto taastatud", null, email + " · omanik · " + SOURCE);
      return { action: samePassword ? "promoted" : "reset", shopId: u.shop_id || u.id };
    }

    // The shop is the account it was created with; the oldest one is the
    // shop's. A database with no shop at all is a new one, and gets one.
    const shop = await client.query("SELECT id FROM users WHERE id = shop_id ORDER BY id LIMIT 1");
    const created = await client.query(
      "INSERT INTO users (email, password_hash, name, role, shop_id) VALUES ($1,$2,$3,'omanik',$4) RETURNING id",
      [email, await hashPassword(password), name, shop.rowCount ? shop.rows[0].id : null]
    );
    const userId = created.rows[0].id;
    if (!shop.rowCount) {
      await client.query("UPDATE users SET shop_id = id WHERE id = $1", [userId]);
      await seedDefaults(client, userId);
    }
    const shopId = shop.rowCount ? shop.rows[0].id : userId;
    await audit(client, shopId, null, "konto loodud", null, email + " · omanik · " + SOURCE);
    return { action: shop.rowCount ? "created" : "created-shop", shopId };
  });

  const said = {
    unchanged: "on olemas ja parool klapib",
    promoted: "tehti aktiivseks omanikuks",
    reset: "sai uue parooli",
    created: "loodi omanikuna olemasolevasse salongi",
    "created-shop": "loodi koos uue salongi ja vaikimisi hinnakirjaga",
  }[result.action];
  log("Admin: " + email + " " + said + ". Kui oled sisse loginud, eemalda ADMIN_EMAIL ja ADMIN_PASSWORD " +
    "Renderi seadetest — seni pannakse see parool igal käivitusel tagasi.");
  return result;
}

module.exports = { ensureAdmin };
