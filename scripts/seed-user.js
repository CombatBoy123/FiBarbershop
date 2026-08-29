// seed-user.js — create a staff account from the command line.
// Public registration is off by default, so this is how the shop's first
// login is made:
//
//   SEED_EMAIL=info@fibarbers.ee SEED_PASSWORD='...' npm run seed-user
//
// Pass the password through the environment, not as an argument: arguments
// land in your shell history and in the process list, environment values do
// not. The password is never printed back.

require("dotenv").config();

const { pool, withTransaction } = require("../src/db");
const { hashPassword } = require("../src/auth");
const { seedDefaults } = require("../src/seed");

async function main() {
  const email = String(process.env.SEED_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.SEED_PASSWORD || "");
  const name = String(process.env.SEED_NAME || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set SEED_EMAIL to a valid email address.");
  }
  if (password.length < 8) {
    throw new Error("Set SEED_PASSWORD to at least 8 characters.");
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) {
    // Rotating a forgotten password is the common reason to re-run this.
    await pool.query("UPDATE users SET password_hash = $2 WHERE email = $1", [
      email,
      await hashPassword(password),
    ]);
    console.log("Parool uuendatud kontole " + email + ".");
    return;
  }

  await withTransaction(async (client) => {
    const r = await client.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id",
      [email, await hashPassword(password), name || null]
    );
    await seedDefaults(client, r.rows[0].id);
  });

  console.log("Konto loodud: " + email + " — hinnakiri ja tooted on ette laaditud.");
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end();
    process.exitCode = 1;
  });
