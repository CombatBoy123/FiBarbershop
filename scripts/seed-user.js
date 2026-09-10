// seed-user.js — create a staff account from the command line.
// Public registration is off by default, so this is how the shop's first
// login is made:
//
//   SEED_EMAIL=info@fibarbers.ee SEED_PASSWORD='...' npm run seed-user
//
// To add someone to a shop that already exists — which is almost always what
// you want once the shop is running — name the shop's owner:
//
//   SEED_SHOP=test@fibarbers.ee SEED_EMAIL=kristen@fibarbers.ee \
//   SEED_ROLE=omanik SEED_PASSWORD='...' npm run seed-user
//
// Without SEED_SHOP the account becomes a shop of its own, with its own empty
// books — right for the very first login, wrong for everyone after it.
//
// Pass the password through the environment, not as an argument: arguments
// land in your shell history and in the process list, environment values do
// not. The password is never printed back.

require("dotenv").config();

const { pool, withTransaction } = require("../src/db");
const { hashPassword, ROLES } = require("../src/auth");
const { seedDefaults } = require("../src/seed");

async function main() {
  const email = String(process.env.SEED_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.SEED_PASSWORD || "");
  const name = String(process.env.SEED_NAME || "").trim();
  const shopEmail = String(process.env.SEED_SHOP || "").trim().toLowerCase();
  const role = String(process.env.SEED_ROLE || "omanik").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set SEED_EMAIL to a valid email address.");
  }
  if (password.length < 8) {
    throw new Error("Set SEED_PASSWORD to at least 8 characters.");
  }
  if (!ROLES.includes(role)) {
    throw new Error("SEED_ROLE must be one of: " + ROLES.join(", "));
  }

  // Which shop's books this account will see. users.id doubles as the shop id,
  // so joining an existing shop means pointing shop_id at that shop's owner.
  let shopId = null;
  if (shopEmail) {
    const s = await pool.query("SELECT id, shop_id FROM users WHERE email = $1", [shopEmail]);
    if (!s.rowCount) throw new Error("No account found for SEED_SHOP=" + shopEmail);
    shopId = s.rows[0].shop_id || s.rows[0].id;
  }

  const existing = await pool.query("SELECT id, shop_id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) {
    // Rotating a forgotten password is the common reason to re-run this. Role
    // and shop are set too, so this doubles as a repair for an account left
    // without either.
    await pool.query(
      `UPDATE users SET password_hash = $2, role = $3,
              shop_id = COALESCE($4, shop_id, id), active = true
        WHERE email = $1`,
      [email, await hashPassword(password), role, shopId]
    );
    console.log("Parool uuendatud kontole " + email + " (roll: " + role + ").");
    return;
  }

  await withTransaction(async (client) => {
    const r = await client.query(
      "INSERT INTO users (email, password_hash, name, shop_id, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [email, await hashPassword(password), name || null, shopId, role]
    );
    if (!shopId) {
      // A brand-new shop: point it at itself and give it a price list to start
      // from. An account joining an existing shop must NOT be seeded — it
      // already has that shop's price list, products and books.
      await client.query("UPDATE users SET shop_id = id WHERE id = $1", [r.rows[0].id]);
      await seedDefaults(client, r.rows[0].id);
    }
  });

  console.log(
    shopId
      ? "Konto loodud: " + email + " (roll: " + role + ") — näeb sama salongi raamatuid."
      : "Konto loodud: " + email + " — uus salong, hinnakiri ja tooted on ette laaditud."
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end();
    process.exitCode = 1;
  });
