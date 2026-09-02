// main.js — boot, session, navigation and every action the views call.
// This is the only module that both reads state and writes to the server.

import { api, setToken, getToken, ApiError } from "./api.js";
import {
  S, applyState, addLine, removeLine, updateLine, clearDraft, setMethod,
  syncPayment, draftTotal, draftVat, paymentMismatch, METHOD_LABEL,
} from "./state.js";
import { VIEWS } from "./views.js";
import { clear, toast, eur, num, dateET, todayISO, parseNum, downloadCSV, h } from "./util.js";
import { BARBERS, barberById, defaultBarber, startingPrice } from "./barbers.data.js";

const loginEl = document.getElementById("login");
const appEl = document.getElementById("app");
const viewEl = document.getElementById("view");

// ------------------------------------------------------------------ theme

function applyTheme(theme) {
  S.theme = theme === "dark" ? "dark" : "light";
  appEl.classList.toggle("dark", S.theme === "dark");
  for (const b of document.querySelectorAll("[data-theme]")) {
    b.classList.toggle("on", b.dataset.theme === S.theme);
  }
  try {
    localStorage.setItem("fi_theme", S.theme);
  } catch (e) {
    /* storage blocked; the theme simply resets next visit */
  }
}

// ------------------------------------------------------------ barber pick
// A compact navbar control: a name button showing the active barber and a
// caret button that drops down the five profiles. The choice sets whose price
// list and cut times the till uses, and is remembered across visits.

const barberSelEl = document.getElementById("barberSel");
let barberMenuOpen = false;

function selectBarber(id, { rerender = true } = {}) {
  const b = barberById(id) || defaultBarber();
  S.activeBarberId = b.id;
  try {
    localStorage.setItem("fi.activeBarber", b.id);
  } catch (e) {
    /* storage blocked; the choice simply resets next visit */
  }
  updateBarberSelector();
  if (rerender && !appEl.hidden) render();
}

function closeBarberMenu(returnFocus) {
  if (!barberMenuOpen) return;
  barberMenuOpen = false;
  const menu = barberSelEl.querySelector(".bsel-menu");
  const name = barberSelEl.querySelector(".bsel-name");
  if (menu) menu.hidden = true;
  if (name) name.setAttribute("aria-expanded", "false");
  barberSelEl.classList.remove("open");
  document.removeEventListener("mousedown", onBarberDocDown, true);
  if (returnFocus && name) name.focus();
}

function openBarberMenu() {
  if (barberMenuOpen) return;
  barberMenuOpen = true;
  const menu = barberSelEl.querySelector(".bsel-menu");
  const name = barberSelEl.querySelector(".bsel-name");
  if (menu) menu.hidden = false;
  if (name) name.setAttribute("aria-expanded", "true");
  barberSelEl.classList.add("open");
  const sel = barberSelEl.querySelector('.bsel-opt[aria-selected="true"]') ||
    barberSelEl.querySelector(".bsel-opt");
  if (sel) sel.focus();
  document.addEventListener("mousedown", onBarberDocDown, true);
}

function onBarberDocDown(e) {
  if (!barberSelEl.contains(e.target)) closeBarberMenu(false);
}

function toggleBarberMenu() {
  if (barberMenuOpen) closeBarberMenu(true);
  else openBarberMenu();
}

function updateBarberSelector() {
  if (!barberSelEl) return;
  const active = barberById(S.activeBarberId) || defaultBarber();
  const label = barberSelEl.querySelector(".bsel-text");
  if (label) label.textContent = active.displayName;
  for (const opt of barberSelEl.querySelectorAll(".bsel-opt")) {
    opt.setAttribute("aria-selected", opt.dataset.id === active.id ? "true" : "false");
  }
}

function buildBarberSelector() {
  if (!barberSelEl) return;
  const active = barberById(S.activeBarberId) || defaultBarber();

  const nameBtn = h("button", {
    class: "bsel-name", type: "button", id: "barberName",
    "aria-haspopup": "listbox", "aria-expanded": "false",
    title: "Aktiivne barber — määrab hinnad ja ajad",
    onclick: toggleBarberMenu,
  }, h("span", { class: "bsel-text", text: active.displayName }));

  const caretBtn = h("button", {
    class: "bsel-caret", type: "button", "aria-label": "Vali barber",
    "aria-haspopup": "listbox", tabindex: "-1", onclick: toggleBarberMenu,
  }, "▾");

  const options = BARBERS.map((b) => {
    const sp = startingPrice(b);
    return h("li", {
      class: "bsel-opt", role: "option", "data-id": b.id,
      "aria-selected": b.id === active.id ? "true" : "false", tabindex: "-1",
      onclick: () => { selectBarber(b.id); closeBarberMenu(true); },
      onkeydown: (e) => onOptionKeydown(e, b.id),
    },
      h("span", { class: "bsel-opt-name", text: b.displayName }),
      h("span", { class: "bsel-opt-meta", text: b.tier + (sp != null ? " · alates " + sp + " €" : "") }),
      h("span", { class: "bsel-check", "aria-hidden": "true", text: "✓" })
    );
  });

  const menu = h("ul", { class: "bsel-menu", role: "listbox", "aria-label": "Barber", hidden: true }, ...options);

  nameBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openBarberMenu(); }
  });

  clear(barberSelEl);
  barberSelEl.append(nameBtn, caretBtn, menu);
}

function onOptionKeydown(e, id) {
  const opts = [...barberSelEl.querySelectorAll(".bsel-opt")];
  const idx = opts.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); (opts[idx + 1] || opts[0]).focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); (opts[idx - 1] || opts[opts.length - 1]).focus(); }
  else if (e.key === "Home") { e.preventDefault(); opts[0].focus(); }
  else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1].focus(); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectBarber(id); closeBarberMenu(true); }
  else if (e.key === "Escape") { e.preventDefault(); closeBarberMenu(true); }
}

// ----------------------------------------------------------------- render

function render() {
  for (const b of document.querySelectorAll(".navtab[data-tab]")) {
    b.classList.toggle("on", b.dataset.tab === S.tab);
  }
  const view = VIEWS[S.tab] || VIEWS.pos;
  clear(viewEl).append(...view(actions));
  document.getElementById("navDate").textContent = dateET(todayISO());
}

// Typing in a quantity, price, tip or split field must not rebuild the panel,
// or the input would lose focus mid-keystroke. Only the derived numbers are
// repainted in place.
function refreshTotals() {
  const vat = draftVat();
  const total = draftTotal();
  const mismatch = paymentMismatch();

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("posNet", num(vat.net));
  set("posVat", num(vat.vat));
  set("posTotal", eur(total));

  for (const [id, value] of [["posCash", S.draft.cash], ["posCard", S.draft.card]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el !== document.activeElement) el.value = String(value);
    el.disabled = S.draft.method !== "split";
  }

  const err = document.getElementById("posErr");
  if (err) {
    err.textContent =
      S.draft.lines.length && mismatch !== 0
        ? "Vahe " + num(Math.abs(mismatch) / 100) + " € — sularaha ja kaart kokku peavad võrduma summaga."
        : "";
  }
  const blocked = !S.draft.lines.length || mismatch !== 0;
  const finish = document.getElementById("posFinish");
  if (finish) finish.disabled = blocked;

  set("barTotal", eur(total));
  set("barCount", S.draft.lines.length + " rida · " + METHOD_LABEL[S.draft.method]);
  const barFinish = document.getElementById("barFinish");
  if (barFinish) barFinish.disabled = blocked;
}

// A failed call is either a dead session or something the user should read.
async function guard(fn, { silent = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      signOut("Sessioon aegus. Palun logi uuesti sisse.");
      return null;
    }
    if (!silent) toast(err.message || "Midagi läks valesti.");
    return null;
  }
}

async function refreshFromServer() {
  const data = await guard(() => api.bootstrap());
  if (data) {
    applyState(data);
    render();
  }
}

// ---------------------------------------------------------------- actions

const actions = {
  goto(tab) {
    S.tab = tab;
    render();
  },

  openInvoice(id) {
    S.selectedInvoiceId = id;
    S.tab = "inv";
    render();
  },

  // ---- the sale being rung up
  addLine(line) {
    addLine(line);
    render();
  },

  removeLine(key) {
    removeLine(key);
    render();
  },

  updateLine(key, patch) {
    updateLine(key, patch);
    refreshTotals();
  },

  setTip(value) {
    S.draft.tip = value;
    syncPayment();
    refreshTotals();
  },

  setMethod(method) {
    setMethod(method);
    render();
  },

  setPayment(patch) {
    Object.assign(S.draft, patch);
    refreshTotals();
  },

  // The buyer fields are free text that no figure depends on, so nothing is
  // repainted: a rebuild here would pull the caret out of the field mid-word.
  setBuyer(patch) {
    Object.assign(S.draft, patch);
  },

  clearDraft() {
    clearDraft();
    render();
  },

  async finishSale() {
    if (!S.draft.lines.length) return;
    const button = document.getElementById("posFinish");
    if (button) button.disabled = true;

    const result = await guard(() =>
      api.createSale({
        date: todayISO(),
        lines: S.draft.lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          qty: l.qty,
          price: l.price,
        })),
        buyerName: S.draft.buyerName.trim(),
        buyerDetails: S.draft.buyerDetails.trim(),
        tip: S.draft.tip,
        cash: parseNum(S.draft.cash),
        card: parseNum(S.draft.card),
      })
    );

    if (!result) {
      // The server refused (out of stock, payment mismatch). Its message is
      // already on screen; re-render so the button becomes usable again.
      render();
      return;
    }

    applyState(result.state);
    clearDraft();
    S.selectedInvoiceId = result.invoice.id;
    S.tab = "inv";
    render();
    toast("Arve " + result.invoice.nr + " koostatud · kanne kassaraamatus");
  },

  // Voiding keeps the number and undoes the cash-book entry and the stock
  // movements the sale created.
  async cancelInvoice(invoice) {
    const reason = prompt(
      "Arve " + invoice.nr + " tühistamine.\n\nNumber jääb alles, kassakanne ja laoliikumine keeratakse tagasi.\nPõhjus (vabatahtlik):",
      ""
    );
    if (reason === null) return;
    const result = await guard(() => api.cancelInvoice(invoice.id, reason));
    if (!result) return;
    applyState(result.state);
    render();
    toast("Arve " + invoice.nr + " tühistatud · kassa ja ladu taastatud");
  },

  // ---- kassaraamat
  async addLedger(form) {
    const saved = await guard(() =>
      api.addLedger({
        date: form.date,
        kind: form.kind,
        category:
          form.category === "Muu" && String(form.custom || "").trim()
            ? String(form.custom).trim()
            : form.category,
        description: form.description,
        cash: parseNum(form.cash),
        card: parseNum(form.card),
      })
    );
    if (!saved) return;
    await refreshFromServer();
    toast("Kanne lisatud.");
  },

  async deleteLedger(id) {
    if (!confirm("Kustutada see kassaraamatu kanne?")) return;
    const done = await guard(() => api.removeLedger(id));
    if (!done) return;
    await refreshFromServer();
    toast("Kanne kustutatud.");
  },

  exportLedger() {
    const rows = [["Kuupäev", "Tüüp", "Kategooria", "Kirjeldus", "Sularaha", "Kaart", "Summa"]];
    for (const e of S.ledger) {
      const gross = Number(e.cash || 0) + Number(e.card || 0);
      rows.push([
        dateET(e.entry_date), e.kind, e.category, e.description,
        num(e.cash), num(e.card), num(e.kind === "tulu" ? gross : -gross),
      ]);
    }
    downloadCSV("kassaraamat-" + todayISO() + ".csv", rows);
    toast("CSV alla laaditud.");
  },

  // ---- ladu
  async addMovement(form) {
    if (!form.productId) return toast("Vali toode.");
    const saved = await guard(() =>
      api.addMovement({
        date: form.date,
        productId: form.productId,
        type: form.type,
        qty: parseNum(form.qty),
        price: parseNum(form.price),
      })
    );
    if (!saved) return;
    await refreshFromServer();
    toast("Liikumine lisatud.");
  },

  // Typing a new stock figure books the difference as a movement, so the
  // shelf and the history never disagree.
  async setStock(id, name, qty) {
    const result = await guard(() => api.setStock(id, qty));
    if (!result) {
      render();
      return;
    }
    applyState(result.state);
    render();
    if (result.delta === 0) toast(name + " — jääk oli juba " + qty + " tk.");
    else if (result.delta > 0) toast(name + " — lisatud " + result.delta + " tk, jääk " + qty + " tk.");
    else toast(name + " — maha kantud " + Math.abs(result.delta) + " tk, jääk " + qty + " tk.");
  },

  async deleteMovement(id) {
    if (!confirm("Kustutada see laoliikumine?")) return;
    const done = await guard(() => api.removeMovement(id));
    if (!done) return;
    await refreshFromServer();
    toast("Liikumine kustutatud.");
  },

  // ---- hinnakiri
  async saveSettings(patch) {
    const saved = await guard(() => api.saveSettings(patch));
    if (!saved) return;
    S.settings = saved.settings;
    render();
    toast("Salvestatud.");
  },

  async saveService(id, patch) {
    const saved = await guard(() => api.updateService(id, patch));
    if (!saved) return;
    const i = S.services.findIndex((s) => s.id === id);
    if (i >= 0) S.services[i] = saved.service;
    render();
    toast("Hind salvestatud.");
  },

  async saveProduct(id, patch) {
    const saved = await guard(() => api.updateProduct(id, patch));
    if (!saved) return;
    const i = S.products.findIndex((p) => p.id === id);
    if (i >= 0) S.products[i] = { ...saved.product, stock: S.products[i].stock };
    render();
    toast("Toode salvestatud.");
  },
};

// ---------------------------------------------------------------- session

function showLogin(message) {
  loginEl.hidden = false;
  appEl.hidden = true;
  document.getElementById("loginErr").textContent = message || "";
}

function showApp() {
  loginEl.hidden = true;
  appEl.hidden = false;
}

function signOut(message) {
  setToken(null);
  S.user = null;
  clearDraft();
  showLogin(message);
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = document.getElementById("loginBtn");
  const errEl = document.getElementById("loginErr");
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  errEl.textContent = "";
  button.disabled = true;
  button.textContent = "Login sisse...";

  try {
    const result = await api.login(email, password);
    setToken(result.token);
    S.user = result.user;
    document.getElementById("loginPassword").value = "";
    showApp();
    await refreshFromServer();
  } catch (err) {
    errEl.textContent = err.message || "Sisselogimine ebaõnnestus.";
  } finally {
    button.disabled = false;
    button.textContent = "Logi sisse";
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(""));

for (const b of document.querySelectorAll(".navtab[data-tab]")) {
  b.addEventListener("click", () => actions.goto(b.dataset.tab));
}

for (const b of document.querySelectorAll("[data-theme]")) {
  b.addEventListener("click", () => applyTheme(b.dataset.theme));
}

// ------------------------------------------------------------------- boot

async function boot() {
  let saved = "light";
  try {
    saved = localStorage.getItem("fi_theme") || "light";
  } catch (e) {
    /* storage blocked */
  }
  applyTheme(saved);

  // Restore the active barber (URL of choice is localStorage here), defaulting
  // to the shop's default, then build the navbar selector once.
  let savedBarber = null;
  try {
    savedBarber = localStorage.getItem("fi.activeBarber");
  } catch (e) {
    /* storage blocked */
  }
  S.activeBarberId = barberById(savedBarber) ? savedBarber : defaultBarber().id;
  buildBarberSelector();

  if (!getToken()) {
    showLogin("");
    return;
  }

  try {
    const me = await api.me();
    S.user = me.user;
    showApp();
    await refreshFromServer();
  } catch (err) {
    // An expired or invalid token should drop straight to the login form
    // rather than leaving an empty shell on screen.
    signOut(err instanceof ApiError && err.status === 0 ? err.message : "");
  }
}

boot();
