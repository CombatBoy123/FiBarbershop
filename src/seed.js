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
const DEFAULT_PRODUCTS = [
  ["Uppercut Matte Pomade 100g", 12, 20],
  ["Uppercut Deluxe Clay 70g", 12, 20],
  ["Uppercut Featherweight 70g", 12, 20],
  ["Uppercut Light Hold 90g", 13, 20],
  ["Nõberu Ocean Spray 150ml", 13, 22],
  ["Nõberu After Shave Balm 100ml", 15.5, 26],
  ["Nõberu Hair Wax 100ml", 13, 22],
  ["Nishman Hair Gel Sea Salt 300ml", 6.5, 12],
  ["Fi Texture Powder 20g", 9, 15],
  ["Fi Habemeõli 30ml", 10, 18],
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
