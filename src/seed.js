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

// Retail range carried in the shop: [name, ostuhind, müügihind, photo].
// The range, purchase prices and photos are the shop's own, as they stood in
// its books on 25.09.2026; the photos ship with the app in
// public/assets/products/. Stock is not seeded: a new shop's shelf is what
// is booked in under Ladu.
const DEFAULT_PRODUCTS = [
  ["Fi Texture Powder 20g", 9, 15, "assets/products/fi-texture-powder-20g.jpg"],
  ["Nishmani habeme- ja vuntsihooldusõli 30 ml", 11.77, 15, "assets/products/nishmani-habeme-ja-vuntsihooldusoli-30-ml.webp"],
  ["Nishman must šampoon 2in1 10x20ml", 10, 25, "assets/products/nishman-must-sampoon-2in1-10x20ml.jpg"],
  ["Nishman Curl Cream 200ml", 11.79, 15, "assets/products/nishman-curl-cream-200ml.webp"],
  ["Nishman Hair Gel Sea Salt 300ml", 6.5, 12, "assets/products/nishman-hair-gel-sea-salt-300ml.webp"],
  ["Nishman käte- ja näokreem granaatõun", 8.57, 12, "assets/products/nishman-kate-ja-naokreem-granaatoun.jpg"],
  ["Nishman Kõõmavastane šampoon XL 400ml", 6.63, 15, "assets/products/nishman-koomavastane-sampoon-xl-400ml.webp"],
  ["Nõberu Face & After Shave Balm – Tobacco Vanilla 100ml", 11.2, 26, "assets/products/noberu-face-ja-after-shave-balm-tobacco-vanilla-100ml.png"],
  ["Nõberu Ocean Spray 150ml - Tobacco Vanilla", 8.17, 22, "assets/products/noberu-ocean-spray-150ml-tobacco-vanilla.png"],
  ["Uppercut Deluxe Clay 70g", 12, 20, "assets/products/uppercut-deluxe-clay-70g.webp"],
  ["Uppercut Deluxe Light Hold 90g", 12.18, 20, "assets/products/uppercut-deluxe-light-hold-90g.webp"],
  ["Uppercut Deluxe Matte Pomade 100g", 7.28, 20, "assets/products/uppercut-deluxe-matte-pomade-100g.webp"],
  ["Uppercut Deluxe Salt Spray 150ml", 6.23, 15, "assets/products/uppercut-deluxe-salt-spray-150ml.webp"],
  ["Uppercut Deluxe Texture Cream 100g", 12.04, 20, "assets/products/uppercut-deluxe-texture-cream-100g.webp"],
];

// The shop's barbers and what each of them charges, lifted out of the old
// till add-on (since removed) where these five were hard-coded. Prices are the ones from that file:
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
    const [name, cost, price, image] = DEFAULT_PRODUCTS[i];
    await client.query(
      "INSERT INTO products (user_id, name, cost, price, image_url, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
      [userId, name, cost, price, image || "", i]
    );
  }
  await seedBarbers(client, userId);
}

module.exports = {
  DEFAULT_SERVICES, DEFAULT_PRODUCTS, DEFAULT_BARBERS, seedDefaults, seedBarbers,
};
