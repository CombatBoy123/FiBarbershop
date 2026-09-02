// barbers.data.js — the barber profiles that personalise the till.
// Each barber has their own price list and their own time per cut, so the
// Kiirmüük tiles change when the active barber changes. This is the single
// source of truth for that; no barber name, price or duration is written
// anywhere else.
//
// Adding a barber = adding one entry here. Nothing else needs to change.
//
// Price types:
//   fixed     { type:"fixed",     amount }              -> "35 €"
//   range     { type:"range",     min, max }            -> "40–50 €" (adds min)
//   free      { type:"free" }                           -> "Tasuta"  (adds 0)
//   surcharge { type:"surcharge", amount }              -> "+10 €"
//   scheduled { type:"scheduled", schedule:[...] }      -> date-resolved

export const BARBERS = [
  {
    id: "remm",
    displayName: "Barber Remm",
    tier: "Meister",
    isDefault: true,
    bookingUrl: "https://calendly.com/fibarbershop/01",
    phone: null,
    services: [
      { name: "Habe + Juukselõikus", price: { type: "range", min: 40, max: 50 }, durationMin: 45, isAddOn: false },
      { name: "Juukselõikus",        price: { type: "fixed", amount: 35 },       durationMin: 45, isAddOn: false },
      { name: "Design / hairtattoo", price: { type: "free" },                    durationMin: 45, isAddOn: true },
      { name: "Afterhours (DM)",     price: { type: "surcharge", amount: 10 },   durationMin: 45, isAddOn: true },
    ],
  },
  {
    id: "jax",
    displayName: "Barber Jax",
    tier: "Spetsialist",
    isDefault: false,
    bookingUrl: "https://calendly.com/jakob-puu/barberjax",
    phone: null,
    services: [
      { name: "Habe + Juukselõikus", price: { type: "range", min: 35, max: 40 }, durationMin: 45, isAddOn: false },
      { name: "Juukselõikus",        price: { type: "fixed", amount: 30 },       durationMin: 45, isAddOn: false },
      { name: "Design / hairtattoo", price: { type: "surcharge", amount: 5 },    durationMin: 45, isAddOn: true },
      { name: "Afterhours (DM)",     price: { type: "surcharge", amount: 5 },    durationMin: 45, isAddOn: true },
    ],
  },
  {
    id: "ogfadedoctor",
    displayName: "OGfadedoctor",
    tier: "Külalisbarber",
    isDefault: false,
    bookingUrl: "https://calendly.com/ogfadedoctor/45min?back=1&month=2026-05&utm_id=97757_v0_s00_e0_tv0",
    phone: "5685 2919",
    services: [
      { name: "Tartu lõikuspäev", price: { type: "fixed", amount: 30 }, durationMin: 45, isAddOn: false },
    ],
  },
  {
    id: "kristo",
    displayName: "Barber Kristo",
    tier: "Rookie",
    isDefault: false,
    bookingUrl: "https://calendly.com/barberkristo/0726",
    phone: null,
    services: [
      // Date-driven: 10 € until 1 Sept 2026, 15 € from then on.
      { name: "Juukselõikus", price: { type: "scheduled", schedule: [
        { amount: 10, effectiveFrom: null },
        { amount: 15, effectiveFrom: "2026-09-01" },
      ] }, durationMin: 60, isAddOn: false },
      { name: "Design / hairtattoo",    price: { type: "free" },                  durationMin: 60, isAddOn: true },
      { name: "Afterhours / ületunnid", price: { type: "surcharge", amount: 10 }, durationMin: 60, isAddOn: true },
    ],
  },
  {
    id: "joss",
    displayName: "Barber Joss",
    tier: "Rookie",
    isDefault: false,
    bookingUrl: "https://calendly.com/barberjoss/juusteloikus?utm_source=ig&utm_medium=social&utm_content=link_in_bio&utm_id=97760_v0_s00_e0_tv3",
    phone: null,
    services: [
      { name: "Juukselõikus", price: { type: "fixed", amount: 10 }, durationMin: 90, isAddOn: false },
    ],
  },
];

// ---------------------------------------------------------------- helpers

const byId = Object.fromEntries(BARBERS.map((b) => [b.id, b]));

export const barberById = (id) => byId[id] || null;
export const defaultBarber = () => BARBERS.find((b) => b.isDefault) || BARBERS[0];

// Local date at midnight (never UTC), so the changeover lands on the right
// Estonian day.
function parseLocalDate(iso) {
  if (!iso) return null;
  const p = String(iso).split("-");
  if (p.length !== 3) return null;
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

// Last schedule entry whose effectiveFrom <= now. Pure: pass `now` for tests.
export function resolvePrice(price, now = new Date()) {
  if (!price || price.type !== "scheduled") return price;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entries = [...(price.schedule || [])].sort((a, b) => {
    const da = parseLocalDate(a.effectiveFrom);
    const db = parseLocalDate(b.effectiveFrom);
    if (!da && !db) return 0;
    if (!da) return -1;
    if (!db) return 1;
    return da - db;
  });
  let current = null;
  for (const e of entries) {
    const from = parseLocalDate(e.effectiveFrom);
    if (!from || from <= today) current = e;
  }
  if (!current && entries.length) current = entries[0];
  return { amount: current ? current.amount : 0 };
}

// "45 min", "1 h", "1 h 30 min"
export function formatDuration(minutes) {
  const m = Number(minutes) || 0;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return rem + " min";
  return rem > 0 ? h + " h " + rem + " min" : h + " h";
}

// The numeric price a tile drops into the draft when clicked.
export function priceAmount(price, now = new Date()) {
  if (!price) return 0;
  switch (price.type) {
    case "fixed": return price.amount;
    case "range": return price.min;             // adds the lower bound; editable in the draft
    case "free": return 0;
    case "surcharge": return price.amount;
    case "scheduled": return resolvePrice(price, now).amount;
    default: return 0;
  }
}

// The label a tile shows.
export function priceLabel(price, now = new Date()) {
  if (!price) return "";
  switch (price.type) {
    case "fixed": return price.amount + " €";
    case "range": return price.min + "–" + price.max + " €"; // en-dash
    case "free": return "Tasuta";
    case "surcharge": return "+" + price.amount + " €";
    case "scheduled": return resolvePrice(price, now).amount + " €";
    default: return "";
  }
}

// The lowest main-service price, for the "alates X €" hint in the dropdown.
export function startingPrice(barber, now = new Date()) {
  let min = null;
  for (const s of barber.services || []) {
    if (s.isAddOn) continue;
    const a = s.price.type === "range" ? s.price.min : priceAmount(s.price, now);
    if (a != null && (min === null || a < min)) min = a;
  }
  return min;
}
