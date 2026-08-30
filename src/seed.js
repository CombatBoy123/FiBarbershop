// seed.js — the starting price list and product range for a new account.
// Shared by the register route and `npm run seed-user` so a till created
// either way comes up identical.

// Fi's real service prices (Tartu, 2026).
const DEFAULT_SERVICES = [
  ["Habe + juukselõikus", 45, "40–50 € · 60 min"],
  ["Juukselõikus", 35, "45 min"],
  ["Design / hairtattoo", 5, "Lisatöö"],
  ["Afterhours DM", 10, "Lisatasu"],
  ["Tervitusjook", 0, "Maja poolt"],
  ["Muu (käsitsi)", 0, "Muuda rida"],
];

// Retail range carried in the shop: [name, ostuhind, müügihind].
// The range actually carried in the shop, mirroring fibarbers.ee.
// Purchase prices start at 0 on purpose: only the owner knows them, and an
// invented ostuhind would corrupt the stock valuation from day one.
// Run `npm run sync-products` afterwards to pull in the product photos.
const DEFAULT_PRODUCTS = [
  ["Fi Texture Powder 20g", 0, 15],
  ["Nishmani habeme- ja vuntsihooldusõli 30 ml", 0, 15],
  ["Nishman must šampoon 2in1 10x20ml", 0, 25],
  ["Nishman Curl Cream 200ml", 0, 15],
  ["Nishman Hair Gel Sea Salt 300ml", 0, 12],
  ["Nishman käte- ja näokreem granaatõun", 0, 12],
  ["Nishman Kõõmavastane šampoon XL 400ml", 0, 15],
  ["Nõberu Face & After Shave Balm – Tobacco Vanilla 100ml", 0, 26],
  ["Nõberu Ocean Spray 150ml - Tobacco Vanilla", 0, 22],
  ["Uppercut Deluxe Clay 70g", 0, 20],
  ["Uppercut Deluxe Light Hold 90g", 0, 20],
  ["Uppercut Deluxe Matte Pomade 100g", 0, 20],
  ["Uppercut Deluxe Salt Spray 150ml", 0, 15],
  ["Uppercut Deluxe Texture Cream 100g", 0, 20],
];

async function seedDefaults(client, userId) {
  await client.query("INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  for (let i = 0; i < DEFAULT_SERVICES.length; i++) {
    const [name, price, note] = DEFAULT_SERVICES[i];
    await client.query(
      "INSERT INTO services (user_id, name, price, note, sort_order) VALUES ($1,$2,$3,$4,$5)",
      [userId, name, price, note, i]
    );
  }
  for (let i = 0; i < DEFAULT_PRODUCTS.length; i++) {
    const [name, cost, price] = DEFAULT_PRODUCTS[i];
    await client.query(
      "INSERT INTO products (user_id, name, cost, price, sort_order) VALUES ($1,$2,$3,$4,$5)",
      [userId, name, cost, price, i]
    );
  }
}

module.exports = { DEFAULT_SERVICES, DEFAULT_PRODUCTS, seedDefaults };
