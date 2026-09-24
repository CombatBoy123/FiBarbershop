// state.js — the client-side store and every number derived from it.
// Nothing here writes to the server; it holds what /api/bootstrap returned
// plus the in-progress sale, and computes the figures the views display.

import { parseNum, todayISO } from "./util.js";

export const S = {
  user: null,
  me: null,          // { id, email, name, role } — decides which buttons show
  tab: "pos",
  theme: "light",
  settings: null,
  services: [],
  products: [],
  invoices: [],
  ledger: [],
  movements: [],
  staff: [],
  customers: [],
  barbers: [],
  audit: [],
  selectedInvoiceId: null,
  selectedCustomerId: null,
  selectedBarberId: null,  // whose prices Hinnakiri shows
  activeBarberId: null,    // who is in the chair at the till
  reportMonth: null,
  ledgerMonth: null,       // null = the current month

  // the sale being rung up
  draft: {
    // { key, productId|null, serviceId|null, name, note, unit, qty, price, discount, open }
    //
    // Every field is written onto the invoice as a copy. That is what lets the
    // same haircut go out at 35 € on one invoice and 40 € on the next without
    // either one touching the price list.
    lines: [],
    // Left empty for an ordinary walk-in; the server then writes "Eraklient"
    // on the invoice. Filled in when a company or a named person needs the
    // invoice made out to them.
    buyerName: "",
    buyerDetails: "",
    customerId: null,
    tip: 0,
    method: "card",  // cash | card | split | later
    cash: 0,
    card: 0,
    // Set when an existing draft is being edited rather than a new sale rung
    // up, so finishing updates that invoice instead of creating another.
    editingId: null,
  },
};

export const isOwner = () => !S.me || S.me.role === "omanik";

// The parts of the app an owner can switch on and off per account, under
// Kontod. Mirrors the list in src/auth.js; the server decides, this is only
// what the screen draws.
export const AREAS = ["cust", "price", "cash", "stock", "admin", "void"];

export const AREA_LABEL = {
  cust: "Kliendid",
  price: "Hinnakiri",
  cash: "Kassaraamat",
  stock: "Ladu",
  admin: "Kontod",
  void: "Arvete kustutamine",
};

// Kliendid stays on for a barber nobody has configured, because barbers had it
// before these switches existed; cancelling and deleting invoices is on too.
const DEFAULT_PERMS = { cust: true, price: false, cash: false, stock: false, admin: false, void: true };

// What THIS account may reach. The server sends `can` already resolved, so the
// rules live in one place; the fallback below only covers the moment between
// login and the first bootstrap.
export function can(area) {
  if (!S.me) return true;
  if (S.me.role === "omanik") return true;
  if (S.me.can && Object.prototype.hasOwnProperty.call(S.me.can, area)) return Boolean(S.me.can[area]);
  return permsOf(S.me)[area];
}

// The effective switches for any account in the staff list, defaults filled in.
export function permsOf(user) {
  const out = {};
  const granted = (user && user.permissions) || {};
  for (const area of AREAS) {
    out[area] = user && user.role === "omanik"
      ? true
      : Object.prototype.hasOwnProperty.call(granted, area)
        ? Boolean(granted[area])
        : DEFAULT_PERMS[area];
  }
  return out;
}

// Replaces everything the server owns. The draft is deliberately left alone:
// a background refresh must never wipe a half-finished sale.
export function applyState(data) {
  S.settings = data.settings;
  S.services = data.services || [];
  S.products = data.products || [];
  S.invoices = data.invoices || [];
  S.ledger = data.ledger || [];
  S.movements = data.movements || [];
  S.staff = data.staff || [];
  S.customers = data.customers || [];
  S.barbers = data.barbers || [];
  S.audit = data.audit || [];
  if (data.me) S.me = data.me;
  if (S.selectedInvoiceId && !S.invoices.some((i) => i.id === S.selectedInvoiceId)) {
    S.selectedInvoiceId = null;
  }
  if (!S.selectedInvoiceId && S.invoices.length) S.selectedInvoiceId = S.invoices[0].id;
  if (S.selectedCustomerId && !S.customers.some((c) => c.id === S.selectedCustomerId)) {
    S.selectedCustomerId = null;
  }
}

// ------------------------------------------------------------- barbers

export const barberById = (id) => S.barbers.find((b) => b.id === id) || null;

// What this barber charges for a service, and whether they perform it at all.
// Falls back to the shop's own price so a service added after the barber was
// created still has a number on it.
export function barberPrice(barber, service) {
  const row = barber && barber.prices ? barber.prices[service.id] : null;
  if (!row) return { price: Number(service.price), offered: false };
  return { price: Number(row.price), offered: Boolean(row.offered) };
}

// The barber this account IS, when the owner has linked the two. That link is
// what lets a barber open Hinnakiri and see their own prices without anyone
// handing them a picker.
export function myBarber() {
  if (!S.me) return null;
  return S.barbers.find((b) => b.account_id === S.me.id) || null;
}

// ---------------------------------------------------------- at the chair
//
// Who is cutting decides the price on a service line and whether the service
// can be rung up at all. This used to live in a separate add-on script that
// read the till's DOM, guessed which service was which by matching words
// like "habe" in its name, and rewrote prices by firing fake input events —
// so a new "Laste lõikus" got the adult haircut price, and the chosen barber
// was forgotten on every reload. It is now ordinary state, priced by service
// id from the barber_prices table.

const BARBER_KEY = "fi_barber";

export function restoreActiveBarber() {
  try {
    const saved = Number(localStorage.getItem(BARBER_KEY));
    if (saved) S.activeBarberId = saved;
  } catch (e) {
    /* storage blocked; the first barber is used */
  }
}

export function setActiveBarber(id) {
  S.activeBarberId = id;
  try {
    localStorage.setItem(BARBER_KEY, String(id));
  } catch (e) {
    /* remembered for this visit only */
  }
}

// A barber's login tied to a chair only ever rings up under that name: the
// picker is not offered to them at all.
export function lockedBarber() {
  return !isOwner() && myBarber() ? myBarber() : null;
}

export function activeBarber() {
  if (!S.barbers.length) return null;
  return lockedBarber() || barberById(S.activeBarberId) || S.barbers[0];
}

// What the tile for this service shows right now: the chair's price, and
// whether that barber performs it. With no barbers set up, the shop's own
// price list is the till.
export function tileFor(service) {
  const b = activeBarber();
  if (!b) return { price: Number(service.price), offered: true };
  return barberPrice(b, service);
}

// One tap on a service tile, as the line it becomes. The price is, in order:
// what this customer has been promised, what this barber charges, what the
// shop charges. The barber's name goes on as the line's description, so a
// second barber's haircuts stay a row of their own on a consolidated invoice.
export function serviceLine(service) {
  const b = activeBarber();
  const c = customerById(S.draft.customerId);
  const agreed = c && c.prices ? c.prices[service.id] : undefined;
  return {
    serviceId: service.id,
    barberId: b ? b.id : null,
    name: service.name,
    price: agreed !== undefined ? Number(agreed) : tileFor(service).price,
    note: b ? b.name : "",
  };
}

// What each barber brought in over one month. Built from the invoice lines
// already in state, so it needs no extra call.
//
// A line says whose work it was through barber_id. Lines written before that
// column existed fall back to matching the barber's name in the description,
// which is where the till has been writing it all along; anything neither can
// place is grouped as "Määramata" rather than being quietly dropped.
export function monthlyByBarber(month) {
  const key = String(month || todayISO()).slice(0, 7);
  const rows = new Map();
  const bump = (name, line, gross) => {
    if (!rows.has(name)) rows.set(name, { barber: name, lines: 0, qty: 0, gross: 0, services: new Map() });
    const r = rows.get(name);
    r.lines += 1;
    r.qty += Number(line.qty) || 0;
    r.gross += gross;
    const s = r.services.get(line.name) || { name: line.name, qty: 0, gross: 0 };
    s.qty += Number(line.qty) || 0;
    s.gross += gross;
    r.services.set(line.name, s);
  };

  for (const inv of S.invoices) {
    if (isCancelled(inv) || isDraft(inv)) continue;
    if (String(inv.invoice_date).slice(0, 7) !== key) continue;
    for (const l of inv.lines || []) {
      const byId = l.barber_id ? S.barbers.find((b) => b.id === l.barber_id) : null;
      const byNote = !byId && l.note ? S.barbers.find((b) => b.name === String(l.note).trim()) : null;
      const who = byId || byNote;
      bump(who ? who.name : "Määramata", l, lineTotal(l));
    }
  }

  const out = [...rows.values()].map((r) => ({
    ...r,
    gross: Math.round(r.gross * 100) / 100,
    services: [...r.services.values()]
      .map((s) => ({ ...s, gross: Math.round(s.gross * 100) / 100 }))
      .sort((a, b) => b.gross - a.gross),
  }));
  out.sort((a, b) => b.gross - a.gross);
  return out;
}

// The months that actually have invoices, newest first, for the picker.
export function invoiceMonths() {
  const set = new Set();
  for (const i of S.invoices) {
    if (isDraft(i)) continue;
    set.add(String(i.invoice_date).slice(0, 7));
  }
  if (!set.size) set.add(todayISO().slice(0, 7));
  return [...set].sort().reverse();
}

// ------------------------------------------------------------- the draft

let keySeq = 0;

const blankLine = (l) => ({
  key: ++keySeq,
  productId: l.productId == null ? null : l.productId,
  serviceId: l.serviceId == null ? null : l.serviceId,
  barberId: l.barberId == null ? null : l.barberId,
  name: l.name,
  note: l.note || "",
  unit: l.unit || "tk",
  qty: Number(l.qty) || 1,
  price: Number(l.price) || 0,
  discount: Number(l.discount) || 0,
  open: false,
});

export function addLine(line) {
  // Clicking the same tile twice bumps the quantity rather than stacking
  // duplicate rows — how a till is actually used.
  //
  // The description is part of what makes two rows the same. That is what
  // keeps a week's consolidated invoice readable: one barber's haircuts stack
  // into a single line, but a second barber's haircuts carry a different
  // description and stay a line of their own, at their own price. Two rows
  // that differ in price or discount are likewise deliberately separate.
  const note = line.note || "";
  const existing = S.draft.lines.find(
    (l) =>
      l.productId === (line.productId == null ? null : line.productId) &&
      l.barberId === (line.barberId == null ? null : line.barberId) &&
      l.name === line.name &&
      (l.note || "") === note &&
      Number(l.price) === (Number(line.price) || 0) &&
      Number(l.discount) === 0
  );
  if (existing) existing.qty += 1;
  else S.draft.lines.push(blankLine(line));
  syncPayment();
}

// A second row of the same service, ready to be given its own price. The copy
// opens expanded, because the only reason to make one is to change something.
export function duplicateLine(key) {
  const i = S.draft.lines.findIndex((l) => l.key === key);
  if (i < 0) return null;
  const copy = blankLine(S.draft.lines[i]);
  copy.open = true;
  S.draft.lines.splice(i + 1, 0, copy);
  syncPayment();
  return copy.key;
}

export function removeLine(key) {
  S.draft.lines = S.draft.lines.filter((l) => l.key !== key);
  syncPayment();
}

export function updateLine(key, patch) {
  const line = S.draft.lines.find((l) => l.key === key);
  if (!line) return;
  Object.assign(line, patch);
  syncPayment();
}

export function toggleLine(key) {
  const line = S.draft.lines.find((l) => l.key === key);
  if (line) line.open = !line.open;
}

export function clearDraft() {
  S.draft.lines = [];
  S.draft.buyerName = "";
  S.draft.buyerDetails = "";
  S.draft.customerId = null;
  S.draft.tip = 0;
  S.draft.method = "card";
  S.draft.cash = 0;
  S.draft.card = 0;
  S.draft.editingId = null;
}

// Pull a saved draft back into the till so it can be worked on further. This
// is what makes a week-long consolidated invoice possible: add a line on
// Monday, another on Thursday, issue it on Friday.
export function loadDraftFrom(invoice) {
  S.draft.lines = (invoice.lines || []).map((l) =>
    blankLine({
      productId: l.product_id,
      serviceId: l.service_id,
      barberId: l.barber_id,
      name: l.name,
      note: l.note,
      unit: l.unit,
      qty: Number(l.qty),
      price: Number(l.price),
      discount: Number(l.discount),
    })
  );
  S.draft.buyerName = invoice.buyer_name === "Eraklient" ? "" : invoice.buyer_name || "";
  S.draft.buyerDetails = invoice.buyer_details || "";
  S.draft.customerId = invoice.customer_id || null;
  S.draft.tip = Number(invoice.tip) || 0;
  S.draft.method = "later";
  S.draft.editingId = invoice.id;
  syncPayment();
}

// Applying a customer fills in the buyer block and drops their agreed price
// onto every matching line — as a starting figure the operator can still
// override, never as a rule the invoice has to obey.
export function applyCustomer(customerId) {
  S.draft.customerId = customerId || null;
  const c = customerById(customerId);
  if (!c) return;
  S.draft.buyerName = c.name;
  S.draft.buyerDetails = c.details || "";
  for (const line of S.draft.lines) {
    const agreed = line.serviceId && c.prices ? c.prices[line.serviceId] : undefined;
    if (agreed !== undefined) line.price = Number(agreed);
  }
  syncPayment();
}

export function setMethod(method) {
  S.draft.method = method;
  syncPayment();
}

// Cash and card follow the chosen method automatically; only "jaga" (split)
// leaves them for the operator to type, and "later" leaves both at zero
// because nothing has been paid yet.
export function syncPayment() {
  const total = draftTotal();
  if (S.draft.method === "cash") {
    S.draft.cash = total;
    S.draft.card = 0;
  } else if (S.draft.method === "card") {
    S.draft.cash = 0;
    S.draft.card = total;
  } else if (S.draft.method === "later") {
    S.draft.cash = 0;
    S.draft.card = 0;
  }
}

// The discount lives in this one formula. Added as a negative line instead, it
// would land outside the VAT base and quietly falsify the invoice.
export const lineTotal = (l) =>
  Math.round(Number(l.price) * Number(l.qty) * (1 - Number(l.discount || 0) / 100) * 100) / 100;

export function draftLinesTotal() {
  return Math.round(S.draft.lines.reduce((s, l) => s + lineTotal(l) * 100, 0)) / 100;
}

export function draftTotal() {
  return Math.round((draftLinesTotal() + Number(S.draft.tip || 0)) * 100) / 100;
}

export function draftVat() {
  const rate = Number(S.settings && S.settings.vat_rate) || 0;
  const gross = draftLinesTotal();
  if (!rate) return { net: gross, vat: 0, rate: 0 };
  const net = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  return { net: net, vat: Math.round((gross - net) * 100) / 100, rate };
}

// Anything that would make the server refuse the invoice, caught before the
// button is pressed rather than after.
export function draftProblem() {
  if (!S.draft.lines.length) return "";
  const bad = S.draft.lines.find((l) => !(Number(l.qty) > 0));
  if (bad) return "Real \u201e" + bad.name + "\u201c on kogus null.";
  const unnamed = S.draft.lines.find((l) => !String(l.name || "").trim());
  if (unnamed) return "Ühel real puudub nimi.";
  return "";
}

export function paymentMismatch() {
  // Nothing to reconcile on a credit invoice: the money is expected later, so
  // zero entered against a positive total is correct rather than an error.
  if (S.draft.method === "later") return 0;
  const paid = Math.round((parseNum(S.draft.cash) + parseNum(S.draft.card)) * 100);
  return Math.round(draftTotal() * 100) - paid;
}

// -------------------------------------------------------------- the books

// Running balance over the cash book, oldest first, starting from the opening
// balance in settings. Returned newest-first because that is how it is shown.
export function ledgerWithBalance() {
  let balance = Number((S.settings && S.settings.opening_balance) || 0);
  const asc = [...S.ledger].sort(
    (a, b) => String(a.entry_date).localeCompare(String(b.entry_date)) || a.id - b.id
  );
  const rows = asc.map((e) => {
    const amount = entryAmount(e);
    balance = Math.round((balance + amount) * 100) / 100;
    return { ...e, amount, balance };
  });
  return rows.reverse();
}

// Bank transfers count as money in, but they are neither the drawer nor the
// terminal — hence their own column rather than being folded into either.
export const entryAmount = (e) => {
  const gross =
    Math.round((Number(e.cash || 0) + Number(e.card || 0) + Number(e.bank || 0)) * 100) / 100;
  return e.kind === "tulu" ? gross : -gross;
};

// Months that have cash-book entries, newest first, always including this one.
export function ledgerMonths() {
  const set = new Set(S.ledger.map((e) => String(e.entry_date).slice(0, 7)));
  set.add(todayISO().slice(0, 7));
  return [...set].sort().reverse();
}

// Totals for one month ('YYYY-MM'), or for the whole book when month is
// empty. The balance is always the running balance at the end of that month —
// the cash in the drawer does not reset on the first of the month.
export function ledgerTotals(month) {
  let cashIn = 0, cardIn = 0, bankIn = 0, out = 0;
  const inMonth = (e) => !month || String(e.entry_date).slice(0, 7) === month;
  const upTo = (e) => !month || String(e.entry_date).slice(0, 7) <= month;
  let closing = 0;
  for (const e of S.ledger) if (upTo(e)) closing += entryAmount(e);
  for (const e of S.ledger.filter(inMonth)) {
    const cash = Number(e.cash || 0), card = Number(e.card || 0), bank = Number(e.bank || 0);
    if (e.kind === "tulu") { cashIn += cash; cardIn += card; bankIn += bank; }
    else out += cash + card + bank;
  }
  const opening = Number((S.settings && S.settings.opening_balance) || 0);
  const r = (n) => Math.round(n * 100) / 100;
  return {
    cashIn: r(cashIn),
    cardIn: r(cardIn),
    bankIn: r(bankIn),
    out: r(out),
    balance: r(opening + closing),
  };
}

// ---------------------------------------------------------------- the day

export const isCancelled = (i) => Boolean(i.cancelled_at);
export const isDraft = (i) => i.status === "mustand";
export const isUnpaid = (i) => i.status === "esitatud";

// cls values are the colour utilities app.css already defines, so a status
// pill needs no new rule of its own.
export const STATUS = {
  mustand: { label: "Mustand", cls: "warnc" },
  esitatud: { label: "Maksmata", cls: "warnc" },
  makstud: { label: "Makstud", cls: "pos" },
  "tühistatud": { label: "Tühistatud", cls: "neg" },
};

export const statusLabel = (i) => STATUS[i.status] || STATUS.makstud;

// Whether this invoice holds the last number of its month. Deleting that one
// frees the number to be issued again; deleting any earlier one leaves a gap
// in the sequence. The delete is allowed either way — this is what lets the
// confirmation say which of the two the owner is about to do.
const seqOf = (nr) => Number(String(nr).split("-")[1]) || 0;

export function isLastOfMonth(invoice) {
  if (!invoice || !invoice.nr) return false;
  const prefix = String(invoice.nr).split("-")[0];
  const mine = seqOf(invoice.nr);
  return !S.invoices.some(
    (i) => i.id !== invoice.id && i.nr && String(i.nr).startsWith(prefix + "-") && seqOf(i.nr) > mine
  );
}

// Money that is owed but has not arrived. Surfaced so an unpaid consolidated
// invoice cannot quietly sit there for two months.
export function unpaidInvoices() {
  return S.invoices.filter((i) => isUnpaid(i) && !isCancelled(i));
}

export function unpaidTotal() {
  return Math.round(unpaidInvoices().reduce((s, i) => s + Number(i.total || 0), 0) * 100) / 100;
}

export function dayFigures(date = todayISO()) {
  // A cancelled invoice is still listed, but it is not turnover. Neither is a
  // draft: nothing has been issued and no money has moved.
  const todays = S.invoices.filter(
    (i) => String(i.invoice_date).slice(0, 10) === date && !isCancelled(i) && !isDraft(i)
  );
  const r = (n) => Math.round(n * 100) / 100;
  return {
    invoices: todays,
    turnover: r(todays.reduce((s, i) => s + Number(i.total || 0), 0)),
    cash: r(todays.reduce((s, i) => s + Number(i.cash || 0), 0)),
    card: r(todays.reduce((s, i) => s + Number(i.card || 0), 0)),
    bank: r(todays.reduce((s, i) => s + Number(i.bank || 0), 0)),
  };
}

// -------------------------------------------------------------- the shelf

// Stock value is counted at cost (ostuhind), which is what the stock is worth
// to the shop — not what it would fetch on the shelf.
export function stockValue() {
  return Math.round(S.products.reduce((s, p) => s + Number(p.stock || 0) * Number(p.cost || 0), 0) * 100) / 100;
}

export const lowLimit = () => Number(S.settings && S.settings.low_stock != null ? S.settings.low_stock : 3);

// A limit of 0 is a real setting ("warn only when it is gone"); the old
// `|| 3` turned it back into 3.
export function lowStock() {
  const limit = lowLimit();
  return S.products.filter((p) => Number(p.stock || 0) <= limit);
}

export function stockStatus(product) {
  const limit = lowLimit();
  const qty = Number(product.stock || 0);
  if (qty <= 0) return { label: "Otsas", cls: "neg" };
  if (qty <= limit) return { label: "Telli juurde", cls: "warnc" };
  return { label: "OK", cls: "pos" };
}

export const METHOD_LABEL = {
  cash: "Sularaha", card: "Kaart", split: "Jaga", later: "Hiljem",
};

export const UNITS = ["tk", "h", "kord", "km", "päev"];

export const productById = (id) => S.products.find((p) => p.id === id) || null;
export const customerById = (id) => S.customers.find((c) => c.id === id) || null;

// Buyer names already used, offered as a datalist so a regular's name does not
// have to be retyped. The cheap version of a customer list, and it costs no
// table — saved customers simply come first.
export function pastBuyers() {
  const seen = new Set(S.customers.map((c) => c.name));
  const out = [...S.customers.map((c) => c.name)];
  for (const i of S.invoices) {
    const n = String(i.buyer_name || "").trim();
    if (n && n !== "Eraklient" && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.slice(0, 60);
}
