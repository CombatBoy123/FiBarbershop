// sync-products.js — pull the product range straight from the Fi shop.
//
//   SYNC_EMAIL=info@fibarbers.ee npm run sync-products
//
// Shopify publishes every collection as JSON, so this reads the real names,
// sale prices and product photos rather than a hand-copied list that drifts.
//
// Photos are DOWNLOADED into public/assets/products/ rather than hotlinked, so
// the till keeps working if the shop front changes its CDN paths, and the
// images ship with the site instead of being fetched from a third party on
// every page load.
//
// Purchase prices (ostuhind) are NOT touched: the shop front does not know
// them, and guessing would put invented numbers into the stock valuation.
// New products come in with cost 0 — fill those in on the Hinnakiri page.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pool, query } = require("../src/db");

const SHOP = process.env.SHOP_URL || "https://fibarbers.ee";
const FEED = SHOP + "/collections/all/products.json?limit=250";

const IMG_DIR = path.join(__dirname, "..", "public", "assets", "products");
const IMG_REL = "assets/products/";

// Estonian letters have to survive into an ASCII filename.
const TRANSLIT = { "õ": "o", "ä": "a", "ö": "o", "ü": "u", "š": "s", "ž": "z", "–": "-", "&": "ja" };

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[õäöüšž–&]/g, (c) => TRANSLIT[c] || c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Shopify resizes on its CDN, so fetch a thumbnail rather than the full photo.
function sized(src, width) {
  return src + (src.includes("?") ? "&" : "?") + "width=" + width;
}

async function downloadImage(src, name) {
  if (!src) return "";
  const ext = (src.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i) || [".jpg"])[0].toLowerCase();
  const file = slug(name) + ext;
  const dest = path.join(IMG_DIR, file);

  const res = await fetch(sized(src, 320));
  if (!res.ok) {
    console.warn("  pilti ei saanud (" + res.status + "): " + name);
    return "";
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return IMG_REL + file;
}


// The shop front prints the figure two ways depending on how low it is:
// "Madal laoseis: 5 alles" or "12 laos". Sold-out products print neither, so
// availability from the JSON feed decides those. Returns null when the page
// says nothing useful, and the till keeps whatever it already had.
async function shopStock(handle, available) {
  try {
    const res = await fetch(SHOP + "/products/" + handle);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/Madal laoseis:\s*(\d+)\s*alles/) || html.match(/(\d+)\s*laos\b/);
    if (m) return Number(m[1]);
    return available ? null : 0;
  } catch (e) {
    return null;
  }
}

// Booking the difference rather than writing a number keeps the movement
// history and the stock figure in agreement.
async function alignStock(userId, productId, target, cost) {
  const cur = await query(
    `SELECT COALESCE(SUM(CASE WHEN move_type = 'in' THEN qty ELSE -qty END), 0) AS qty
       FROM stock_movements WHERE user_id = $1 AND product_id = $2`,
    [userId, productId]
  );
  const diff = target - Number(cur.rows[0].qty);
  if (diff === 0) return 0;
  await query(
    `INSERT INTO stock_movements (user_id, product_id, move_date, move_type, qty, price)
     VALUES ($1,$2,CURRENT_DATE,$3,$4,$5)`,
    [userId, productId, diff > 0 ? "in" : "out", Math.abs(diff), cost || 0]
  );
  return diff;
}

async function main() {
  const email = String(process.env.SYNC_EMAIL || "").trim().toLowerCase();
  if (!email) throw new Error("Set SYNC_EMAIL to the account whose product list should be synced.");

  const u = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (!u.rowCount) throw new Error("Kontot ei leitud: " + email);
  const userId = u.rows[0].id;

  const res = await fetch(FEED, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("Pood ei vastanud: HTTP " + res.status);
  const data = await res.json();

  const incoming = (data.products || [])
    .map((p) => ({
      // Several titles in the shop carry trailing or doubled spaces.
      name: String(p.title || "").replace(/\s+/g, " ").trim(),
      price: Number((p.variants && p.variants[0] && p.variants[0].price) || 0),
      src: (p.images && p.images[0] && p.images[0].src) || "",
      handle: p.handle,
      available: !!(p.variants && p.variants[0] && p.variants[0].available),
    }))
    .filter((p) => p.name);

  if (!incoming.length) throw new Error("Pood tagastas tühja nimekirja — jätan andmebaasi puutumata.");

  fs.mkdirSync(IMG_DIR, { recursive: true });

  let added = 0;
  let updated = 0;
  let images = 0;

  for (let i = 0; i < incoming.length; i++) {
    const p = incoming[i];
    const image = await downloadImage(p.src, p.name);
    if (image) images++;

    const existing = await query(
      "SELECT id FROM products WHERE user_id = $1 AND name = $2",
      [userId, p.name]
    );

    if (existing.rowCount) {
      await query(
        "UPDATE products SET price = $3, image_url = $4, sort_order = $5, active = true WHERE id = $2 AND user_id = $1",
        [userId, existing.rows[0].id, p.price, image, i]
      );
      updated++;
    } else {
      await query(
        "INSERT INTO products (user_id, name, cost, price, image_url, sort_order) VALUES ($1,$2,0,$3,$4,$5)",
        [userId, p.name, p.price, image, i]
      );
      added++;
    }
  }

  // Optional second pass: mirror the stock figures the shop front prints.
  // Off by default — once the till has sales of its own, the shop and the
  // shelf are separate inventories and overwriting one with the other loses
  // real movements.
  let synced = 0;
  let unknown = 0;
  if (process.env.SYNC_STOCK === "1") {
    for (const p of incoming) {
      const row = await query(
        "SELECT id, cost FROM products WHERE user_id = $1 AND name = $2",
        [userId, p.name]
      );
      if (!row.rowCount) continue;
      const target = await shopStock(p.handle, p.available);
      if (target === null) {
        unknown++;
        continue;
      }
      await alignStock(userId, row.rows[0].id, target, Number(row.rows[0].cost));
      synced++;
    }
  }

  // Anything no longer sold is hidden rather than deleted, so old invoices and
  // stock movements keep pointing at a real row.
  const names = incoming.map((p) => p.name);
  const gone = await query(
    "UPDATE products SET active = false WHERE user_id = $1 AND active AND NOT (name = ANY($2)) RETURNING name",
    [userId, names]
  );

  console.log("Poes: " + incoming.length + " toodet | pilte laaditud: " + images);
  console.log("Lisatud: " + added + " | uuendatud: " + updated + " | peidetud: " + gone.rowCount);
  if (process.env.SYNC_STOCK === "1") {
    console.log("Laoseis poest: " + synced + " toodet" + (unknown ? " | " + unknown + " jäi teadmata" : ""));
  }
  if (gone.rowCount) console.log("Peidetud: " + gone.rows.map((r) => r.name).join(", "));

  const zero = await query(
    "SELECT COUNT(*)::int c FROM products WHERE user_id = $1 AND active AND cost = 0",
    [userId]
  );
  if (zero.rows[0].c) {
    console.log("");
    console.log("TÄHELEPANU: " + zero.rows[0].c + " tootel on ostuhind 0.");
    console.log("Lao väärtus jääb nende osas nulliks, kuni sisestad ostuhinnad Hinnakirja lehel.");
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end();
    process.exitCode = 1;
  });
