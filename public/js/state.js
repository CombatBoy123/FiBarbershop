// state.js — the client-side store and every number derived from it.
// Nothing here writes to the server; it holds what /api/bootstrap returned
// plus the in-progress sale, and computes the figures the views display.

import { parseNum, todayISO } from "./util.js";

export const S = {
  user: null,
  tab: "pos",
  theme: "light",
  settings: null,
  services: [],
  products: [],
  invoices: [],
  ledger: [],
  movements: [],
  selectedInvoiceId: null,

  // the sale being rung up
  draft: {
    lines: [],   // { key, productId|null, name, qty, price }
    tip: 0,
    method: "card",  // cash | card | split
    cash: 0,
    card: 0,
  },
};

// Replaces everything the server owns. The draft is deliberately left alone:
// a background refresh must never wipe a half-finished sale.
export function applyState(data) {
  S.settings = data.settings;
  S.services = data.services || [];
  S.products = data.products || [];
  S.invoices = data.invoices || [];
  S.ledger = data.ledger || [];
  S.movements = data.movements || [];
  if (S.selectedInvoiceId && !S.invoices.some((i) => i.id === S.selectedInvoiceId)) {
    S.selectedInvoiceId = null;
  }
  if (!S.selectedInvoiceId && S.invoices.length) S.selectedInvoiceId = S.invoices[0].id;
}

// ------------------------------------------------------------- the draft

let keySeq = 0;

export function addLine({ productId = null, name, price }) {
  // Clicking the same tile twice bumps the quantity rather than stacking
  // duplicate rows — how a till is actually used.
  const existing = S.draft.lines.find((l) => l.productId === productId && l.name === name);
  if (existing) existing.qty += 1;
  else S.draft.lines.push({ key: ++keySeq, productId, name, qty: 1, price: Number(price) || 0 });
  syncPayment();
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

export function clearDraft() {
  S.draft.lines = [];
  S.draft.tip = 0;
  S.draft.method = "card";
  S.draft.cash = 0;
  S.draft.card = 0;
}

export function setMethod(method) {
  S.draft.method = method;
  syncPayment();
}

// Cash and card follow the chosen method automatically; only "jaga" (split)
// leaves them for the operator to type.
export function syncPayment() {
  const total = draftTotal();
  if (S.draft.method === "cash") {
    S.draft.cash = total;
    S.draft.card = 0;
  } else if (S.draft.method === "card") {
    S.draft.cash = 0;
    S.draft.card = total;
  }
}

export const lineTotal = (l) => Math.round(Number(l.price) * Number(l.qty) * 100) / 100;

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
  return { net, vat: Math.round((gross - net) * 100) / 100, rate };
}

export function paymentMismatch() {
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

export const entryAmount = (e) => {
  const gross = Math.round((Number(e.cash || 0) + Number(e.card || 0)) * 100) / 100;
  return e.kind === "tulu" ? gross : -gross;
};

export function ledgerTotals() {
  let cashIn = 0, cardIn = 0, out = 0;
  for (const e of S.ledger) {
    const cash = Number(e.cash || 0), card = Number(e.card || 0);
    if (e.kind === "tulu") { cashIn += cash; cardIn += card; }
    else out += cash + card;
  }
  const opening = Number((S.settings && S.settings.opening_balance) || 0);
  const r = (n) => Math.round(n * 100) / 100;
  return {
    cashIn: r(cashIn),
    cardIn: r(cardIn),
    out: r(out),
    balance: r(opening + cashIn + cardIn - out),
  };
}

// ---------------------------------------------------------------- the day

export const isCancelled = (i) => Boolean(i.cancelled_at);

export function dayFigures(date = todayISO()) {
  // A cancelled invoice is still listed, but it is not turnover.
  const todays = S.invoices.filter(
    (i) => String(i.invoice_date).slice(0, 10) === date && !isCancelled(i)
  );
  const r = (n) => Math.round(n * 100) / 100;
  return {
    invoices: todays,
    turnover: r(todays.reduce((s, i) => s + Number(i.total || 0), 0)),
    cash: r(todays.reduce((s, i) => s + Number(i.cash || 0), 0)),
    card: r(todays.reduce((s, i) => s + Number(i.card || 0), 0)),
  };
}

// -------------------------------------------------------------- the shelf

// Stock value is counted at cost (ostuhind), which is what the stock is worth
// to the shop — not what it would fetch on the shelf.
export function stockValue() {
  return Math.round(S.products.reduce((s, p) => s + Number(p.stock || 0) * Number(p.cost || 0), 0) * 100) / 100;
}

export function lowStock() {
  const limit = Number((S.settings && S.settings.low_stock) || 3);
  return S.products.filter((p) => Number(p.stock || 0) <= limit);
}

export function stockStatus(product) {
  const limit = Number((S.settings && S.settings.low_stock) || 3);
  const qty = Number(product.stock || 0);
  if (qty <= 0) return { label: "Otsas", cls: "neg" };
  if (qty <= limit) return { label: "Telli juurde", cls: "warnc" };
  return { label: "OK", cls: "pos" };
}

export const METHOD_LABEL = { cash: "Sularaha", card: "Kaart", split: "Jaga" };

export const productById = (id) => S.products.find((p) => p.id === id) || null;
