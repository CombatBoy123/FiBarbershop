// main.js — boot, session, navigation and every action the views call.
// This is the only module that both reads state and writes to the server.

import { api, setToken, getToken, ApiError } from "./api.js";
import {
  S, applyState, addLine, removeLine, updateLine, clearDraft, setMethod,
  syncPayment, draftTotal, draftVat, paymentMismatch, METHOD_LABEL,
  duplicateLine, toggleLine, loadDraftFrom, applyCustomer, lineTotal, isOwner,
  isCancelled, isLastOfMonth,
} from "./state.js";
import { VIEWS } from "./views.js";
import { clear, toast, eur, num, dateET, todayISO, parseNum, downloadCSV } from "./util.js";

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

// ----------------------------------------------------------------- render

// Screens a barber has no business in. Hiding the tab is a courtesy, not the
// security boundary — every route behind them checks the role server-side, so
// a hand-typed URL or a poked fetch still comes back 403.
const OWNER_TABS = ["cash", "stock", "price", "admin"];

function render() {
  const owner = isOwner();
  for (const b of document.querySelectorAll(".navtab[data-tab]")) {
    const gated = OWNER_TABS.includes(b.dataset.tab);
    b.hidden = gated && !owner;
    b.classList.toggle("on", b.dataset.tab === S.tab);
  }
  if (!owner && OWNER_TABS.includes(S.tab)) S.tab = "pos";

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
  // Each expanded line shows its own total, and a discount changes it as you
  // type — so the figure is repainted here rather than by rebuilding the row,
  // which would take the caret out of the field mid-keystroke.
  for (const l of S.draft.lines) set("dsum" + l.key, eur(lineTotal(l)));

  const blocked = !S.draft.lines.length || mismatch !== 0;
  const finish = document.getElementById("posFinish");
  if (finish) finish.disabled = blocked;
  const draftBtn = document.getElementById("posDraft");
  if (draftBtn) draftBtn.disabled = !S.draft.lines.length;

  set("barTotal", eur(total));
  set("barCount", S.draft.lines.length + " rida · " + METHOD_LABEL[S.draft.method]);
  const barFinish = document.getElementById("barFinish");
  if (barFinish) barFinish.disabled = blocked;
}

// The invoice as the server wants it. Shared by every path that writes one, so
// a field added to a line is added in exactly one place.
const draftPayload = () => ({
  lines: S.draft.lines.map((l) => ({
    productId: l.productId,
    serviceId: l.serviceId,
    name: l.name,
    note: l.note,
    unit: l.unit,
    qty: l.qty,
    price: l.price,
    discount: l.discount,
  })),
  buyerName: S.draft.buyerName.trim(),
  buyerDetails: S.draft.buyerDetails.trim(),
  customerId: S.draft.customerId,
  tip: S.draft.tip,
});

// Every write returns the whole refreshed state, so this is the one landing
// spot for all of them.
function afterWrite(result, { tab = "inv", invoiceId = null, message = "" } = {}) {
  applyState(result.state);
  if (invoiceId) S.selectedInvoiceId = invoiceId;
  if (tab) S.tab = tab;
  render();
  if (message) toast(message);
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

  // Typing in a line must not rebuild it: only the derived figures repaint,
  // or the caret would jump out of the field between keystrokes.
  updateLine(key, patch) {
    updateLine(key, patch);
    refreshTotals();
  },

  toggleLine(key) {
    toggleLine(key);
    render();
  },

  // A second row of the same service, so it can be given its own price. This
  // is what a consolidated invoice is built from.
  duplicateLine(key) {
    duplicateLine(key);
    render();
  },

  // Picking a regular fills in the buyer block and drops their agreed prices
  // onto matching lines — as a starting figure, still editable per line.
  pickCustomer(id) {
    applyCustomer(id);
    render();
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

  // Park the invoice without issuing it. No number is minted and nothing is
  // booked, so a consolidated invoice can be built up over a week — and thrown
  // away again without leaving a hole in the sequence.
  async saveDraft() {
    if (!S.draft.lines.length) return;
    const id = S.draft.editingId;
    const result = await guard(() =>
      id ? api.updateInvoice(id, draftPayload()) : api.createInvoice(draftPayload())
    );
    if (!result) return;
    const newId = result.invoice.id;
    clearDraft();
    afterWrite(result, { invoiceId: newId, message: "Mustand salvestatud." });
  },

  async finishSale() {
    if (!S.draft.lines.length) return;
    const button = document.getElementById("posFinish");
    if (button) button.disabled = true;

    // Paid on the spot with no draft behind it: the till path, one call and
    // one transaction, exactly as it always was.
    if (!S.draft.editingId && S.draft.method !== "later") {
      const result = await guard(() =>
        api.createSale({
          date: todayISO(),
          ...draftPayload(),
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
      const id = result.invoice.id;
      const nr = result.invoice.nr;
      clearDraft();
      afterWrite(result, { invoiceId: id, message: "Arve " + nr + " koostatud · kanne kassaraamatus" });
      return;
    }

    // Otherwise it is a composed invoice: make sure the draft is saved, then
    // issue it. Issuing is the moment the number is minted and the stock moves.
    let id = S.draft.editingId;
    if (id) {
      const updated = await guard(() => api.updateInvoice(id, draftPayload()));
      if (!updated) return render();
    } else {
      const created = await guard(() => api.createInvoice({ date: todayISO(), ...draftPayload() }));
      if (!created) return render();
      id = created.invoice.id;
    }

    const payNow = S.draft.method !== "later";
    const issued = await guard(() =>
      api.issueInvoice(id, {
        payNow,
        date: todayISO(),
        cash: parseNum(S.draft.cash),
        card: parseNum(S.draft.card),
      })
    );
    if (!issued) return render();

    const nr = issued.invoice.nr;
    clearDraft();
    afterWrite(issued, {
      invoiceId: issued.invoice.id,
      message: payNow
        ? "Arve " + nr + " koostatud · kanne kassaraamatus"
        : "Arve " + nr + " esitatud · maksmata, tähtaeg " + dateET(issued.invoice.due_date),
    });
  },

  // Reopen a saved draft in the till so more lines can be added to it.
  editDraft(invoice) {
    loadDraftFrom(invoice);
    S.tab = "pos";
    render();
    toast("Mustand avatud — lisa read ja esita arve, kui valmis.");
  },

  async deleteDraft(invoice) {
    if (!confirm("Kustutada see mustand?\n\nNumbrit pole eraldatud ja kassaraamatusse pole midagi kirjutatud, nii et midagi muud ei muutu.")) return;
    const result = await guard(() => api.deleteInvoice(invoice.id));
    if (!result) return;
    if (S.draft.editingId === invoice.id) clearDraft();
    afterWrite(result, { message: "Mustand kustutatud." });
  },

  // The money finally arrived. This is what writes the cash-book entry for a
  // credit invoice — weeks after it was issued.
  async payInvoice(invoice) {
    if (!confirm(
      "Märkida arve " + invoice.nr + " makstuks?\n\n" +
      eur(invoice.total) + " kirjutatakse kassaraamatusse ülekandena."
    )) return;
    const result = await guard(() => api.payInvoice(invoice.id, { date: todayISO() }));
    if (!result) return;
    afterWrite(result, { invoiceId: invoice.id, message: "Arve " + invoice.nr + " makstud." });
  },

  // Voiding keeps the number and undoes the cash-book entry and the stock
  // movements the sale created. Two deliberate steps: the number has to be
  // typed out, and the reason is required — one stray Enter used to be enough.
  async cancelInvoice(invoice) {
    const typed = prompt(
      "Arve " + invoice.nr + " tühistamine.\n\n" +
      "Number jääb numbrireas alles, kassakanne ja laoliikumine keeratakse tagasi.\n\n" +
      "Kinnitamiseks kirjuta arve number:",
      ""
    );
    if (typed === null) return;
    if (String(typed).trim() !== String(invoice.nr)) {
      return toast("Number ei klapi — arve jäi tühistamata.");
    }
    const reason = prompt("Tühistamise põhjus (kohustuslik):", "");
    if (reason === null) return;
    if (!String(reason).trim()) {
      return toast("Põhjus on kohustuslik — arve jäi tühistamata.");
    }
    const result = await guard(() => api.cancelInvoice(invoice.id, reason));
    if (!result) return;
    afterWrite(result, { invoiceId: invoice.id,
      message: "Arve " + invoice.nr + " tühistatud · kassa ja ladu taastatud" });
  },

  async uncancelInvoice(invoice) {
    if (!confirm("Võtta arve " + invoice.nr + " tühistamine tagasi?\n\nKassakanne ja laoliikumine taastatakse.")) return;
    const result = await guard(() => api.uncancelInvoice(invoice.id));
    if (!result) return;
    afterWrite(result, { invoiceId: invoice.id, message: "Arve " + invoice.nr + " taastatud." });
  },

  // Remove a cancelled invoice from the books for good. The number is freed
  // and reissued rather than skipped, so the sequence stays unbroken — but the
  // row itself is gone, so this asks for the number in full.
  async purgeInvoice(invoice) {
    // Say which of the two cases this is before asking, because they have very
    // different consequences and only the person deleting can weigh them.
    const last = isLastOfMonth(invoice);
    const consequence = last
      ? "Number " + invoice.nr + " vabaneb ja antakse järgmisele arvele — numbriritta auku ei jää."
      : "HOIATUS: " + invoice.nr + " ei ole kuu viimane arve, nii et numbriritta jääb auk. " +
        "Seda tuleb raamatupidajale osata seletada. Tühistamine hoiaks numbri alles.";

    const typed = prompt(
      "Arve " + invoice.nr + " KUSTUTAMINE JÄÄDAVALT.\n\n" +
      "Rida kaob raamatust täielikult ja seda ei saa tagasi võtta.\n" +
      (isCancelled(invoice) ? "" : "Kassakanne ja laoliikumine keeratakse tagasi.\n") +
      consequence + "\n" +
      "Auditijälge jääb kirje: number, ostja, summa ja kuupäev.\n\n" +
      "Kinnitamiseks kirjuta arve number:",
      ""
    );
    if (typed === null) return;
    if (String(typed).trim() !== String(invoice.nr)) {
      return toast("Number ei klapi — arve jäi alles.");
    }
    const result = await guard(() => api.purgeInvoice(invoice.id));
    if (!result) return;
    S.selectedInvoiceId = null;
    afterWrite(result, {
      message: "Arve " + invoice.nr + " kustutatud" +
        (result.leavesGap ? " · numbriritta jäi auk" : " · number vabastatud"),
    });
  },

  // ---- paroolid
  async resetStaffPassword(user) {
    const next = prompt(
      "Uus parool kontole " + user.email + " (vähemalt 8 tähemärki).\n\n" +
      "Vana parool asendatakse. Anna uus töötajale edasi ja lase tal see ise vahetada.",
      ""
    );
    if (next === null) return;
    if (String(next).length < 8) return toast("Parool peab olema vähemalt 8 tähemärki.");
    const result = await guard(() => api.resetStaffPassword(user.id, next));
    if (!result) return;
    afterWrite(result, { tab: "admin", message: "Parool vahetatud: " + user.email });
  },

  async changeMyPassword(form) {
    if (String(form.next || "").length < 8) return toast("Uus parool peab olema vähemalt 8 tähemärki.");
    if (form.next !== form.again) return toast("Uued paroolid ei klapi omavahel.");
    const done = await guard(() => api.changeMyPassword(form.current, form.next));
    if (!done) return;
    render();
    toast("Parool vahetatud.");
  },

  // ---- kliendid
  openCustomer(id) {
    S.selectedCustomerId = id;
    render();
  },

  async addCustomer(form) {
    if (!String(form.name || "").trim()) return toast("Kliendi nimi puudub.");
    const result = await guard(() => api.addCustomer(form));
    if (!result) return;
    S.selectedCustomerId = result.customer.id;
    afterWrite(result, { tab: "cust", message: "Klient lisatud." });
  },

  // An empty field clears the agreement rather than storing a zero, which
  // would mean the service is free for this customer.
  async setCustomerPrice(customerId, serviceId, value) {
    const price = String(value).trim() === "" ? null : parseNum(value);
    const result = await guard(() => api.setCustomerPrice(customerId, serviceId, price));
    if (!result) return;
    afterWrite(result, { tab: "cust", message: price === null ? "Erihind eemaldatud." : "Erihind salvestatud." });
  },

  async removeCustomer(customer) {
    if (!confirm("Eemaldada klient " + customer.name + "?\n\nVarasemad arved jäävad puutumata.")) return;
    const result = await guard(() => api.removeCustomer(customer.id));
    if (!result) return;
    S.selectedCustomerId = null;
    afterWrite(result, { tab: "cust", message: "Klient eemaldatud." });
  },

  // ---- kontod
  async addStaff(form) {
    if (!String(form.email || "").trim()) return toast("E-post puudub.");
    if (String(form.password || "").length < 8) return toast("Parool peab olema vähemalt 8 tähemärki.");
    const result = await guard(() => api.addStaff(form));
    if (!result) return;
    afterWrite(result, { tab: "admin", message: "Konto loodud — anna parool töötajale edasi." });
  },

  async setStaffRole(id, role) {
    const result = await guard(() => api.updateStaff(id, { role }));
    if (!result) return;
    afterWrite(result, { tab: "admin", message: "Roll salvestatud." });
  },

  // Closed, never deleted: invoices point at their creator, so removing the
  // account would erase who rang up last year's sales.
  async closeStaff(user) {
    if (!confirm("Sulgeda konto " + user.email + "?\n\nTa ei saa enam sisse logida. Tema arved jäävad alles.")) return;
    const result = await guard(() => api.removeStaff(user.id));
    if (!result) return;
    afterWrite(result, { tab: "admin", message: "Konto suletud." });
  },

  async reopenStaff(user) {
    const result = await guard(() => api.updateStaff(user.id, { active: true }));
    if (!result) return;
    afterWrite(result, { tab: "admin", message: "Konto taasavatud." });
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
    const rows = [["Kuupäev", "Tüüp", "Kategooria", "Kirjeldus", "Sularaha", "Kaart", "Ülekanne", "Summa"]];
    for (const e of S.ledger) {
      const gross = Number(e.cash || 0) + Number(e.card || 0) + Number(e.bank || 0);
      rows.push([
        dateET(e.entry_date), e.kind, e.category, e.description,
        num(e.cash), num(e.card), num(e.bank), num(e.kind === "tulu" ? gross : -gross),
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
    // Set before the first paint so a barber never sees an owner-only tab
    // flash up while /api/bootstrap is still in flight.
    S.me = result.user;
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

  if (!getToken()) {
    showLogin("");
    return;
  }

  try {
    const me = await api.me();
    S.user = me.user;
    S.me = me.user;
    showApp();
    await refreshFromServer();
  } catch (err) {
    // An expired or invalid token should drop straight to the login form
    // rather than leaving an empty shell on screen.
    signOut(err instanceof ApiError && err.status === 0 ? err.message : "");
  }
}

boot();
