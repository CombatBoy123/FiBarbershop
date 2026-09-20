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

// The shop's barbers and what each of them charges, lifted out of the till
// add-on where these five were hard-coded. Prices are the ones from that file:
// a range became its lower bound, "free" became 0, and Kristo's scheduled
// price became the one in force from 2026-09-01.
//
// A service missing from a barber's list is one they do not perform — what the
// till used to work out by matching words in the name, and what the `offered`
// column now says outright.
const DEFAULT_BARBERS = [
  { slug: "remm", name: "Barber Remm", tier: "Meister", phone: "",
    prices: { "Habe + juukselõikus": 40, "Juukselõikus": 35, "Design / hairtattoo": 0, "Afterhours DM": 10 } },
  { slug: "jax", name: "Barber Jax", tier: "Spetsialist", phone: "",
    prices: { "Habe + juukselõikus": 35, "Juukselõikus": 30, "Design / hairtattoo": 5, "Afterhours DM": 5 } },
  { slug: "ogfadedoctor", name: "OGfadedoctor", tier: "Külalisbarber", phone: "5685 2919",
    prices: { "Juukselõikus": 30 } },
  { slug: "kristo", name: "Barber Kristo", tier: "Rookie", phone: "",
    prices: { "Juukselõikus": 15, "Design / hairtattoo": 0, "Afterhours DM": 10 } },
  { slug: "joss", name: "Barber Joss", tier: "Rookie", phone: "",
    prices: { "Juukselõikus": 10 } },
];

// Offered by everyone at the shop's own price: the welcome drink is on the
// house whoever is in the chair, and the manual line is how any of them rings
// up something the price list does not cover.
const SHOP_WIDE = ["Tervitusjook", "Muu (käsitsi)"];

// Idempotent: a barber that already exists is skipped with their prices left
// alone, which is what makes this usable as a backfill for the shop already
// in production as well as a seed for a new one.
async function seedBarbers(client, userId) {
  const svc = await client.query(
    "SELECT id, name, price FROM services WHERE user_id = $1 AND active", [userId]
  );
  if (!svc.rowCount) return 0;

  let made = 0;
  for (let i = 0; i < DEFAULT_BARBERS.length; i++) {
    const b = DEFAULT_BARBERS[i];
    const r = await client.query(
      `INSERT INTO barbers (user_id, slug, name, tier, phone, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, slug) DO NOTHING
       RETURNING id`,
      [userId, b.slug, b.name, b.tier, b.phone, i]
    );
    if (!r.rowCount) continue;
    made++;

    for (const s of svc.rows) {
      const own = Object.prototype.hasOwnProperty.call(b.prices, s.name);
      const shopWide = SHOP_WIDE.includes(s.name);
      await client.query(
        "INSERT INTO barber_prices (barber_id, service_id, price, offered) VALUES ($1,$2,$3,$4)",
        [
          r.rows[0].id, s.id,
          own ? b.prices[s.name] : shopWide ? Number(s.price) : 0,
          own || shopWide,
        ]
      );
    }
  }
  return made;
}

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
  await seedBarbers(client, userId);
}

module.exports = {
  DEFAULT_SERVICES, DEFAULT_PRODUCTS, DEFAULT_BARBERS, seedDefaults, seedBarbers,
};
