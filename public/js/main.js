// main.js — boot, session, navigation and every action the views call.
// This is the only module that both reads state and writes to the server.

import { api, setToken, getToken, ApiError } from "./api.js";
import {
  S, applyState, addLine, removeLine, updateLine, clearDraft, setMethod,
  syncPayment, draftTotal, draftVat, paymentMismatch, draftProblem, METHOD_LABEL,
  duplicateLine, toggleLine, loadDraftFrom, applyCustomer, lineTotal,
  isCancelled, isLastOfMonth, can, permsOf, AREA_LABEL, monthlyByBarber,
  serviceLine, setActiveBarber, restoreActiveBarber, entryAmount,
} from "./state.js";
import { VIEWS } from "./views.js";
import { ask, confirmAsk } from "./dialog.js";
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

// Screens that sit behind a switch the owner sets per account, under Kontod.
// Töölaud, Kiirmüük and Arved are not on the list: they are the job. Hiding a
// tab is a courtesy, not the security boundary — every route behind them
// checks again server-side.
const GATED_TABS = ["cust", "price", "cash", "stock", "admin", "month"];

// A tab whose permission is named differently from the tab itself.
const TAB_AREA = { month: "admin" };
const areaOfTab = (tab) => TAB_AREA[tab] || tab;

function render() {
  for (const b of document.querySelectorAll(".navtab[data-tab]")) {
    const tab = b.dataset.tab;
    b.hidden = GATED_TABS.includes(tab) && !can(areaOfTab(tab));
    b.classList.toggle("on", tab === S.tab);
    b.setAttribute("aria-selected", String(tab === S.tab));
  }
  // An owner revoking an area while that screen is open leaves nowhere to
  // stand, so fall back to the till.
  if (GATED_TABS.includes(S.tab) && !can(areaOfTab(S.tab))) S.tab = "pos";

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
  const problem = draftProblem();

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

  set("posErr", problem || (S.draft.lines.length && mismatch !== 0
    ? "Vahe " + num(Math.abs(mismatch) / 100) + " € — sularaha ja kaart kokku peavad võrduma summaga."
    : ""));
  // Each expanded line shows its own total, and a discount changes it as you
  // type — so the figure is repainted here rather than by rebuilding the row.
  for (const l of S.draft.lines) set("dsum" + l.key, eur(lineTotal(l)));

  const blocked = saleBusy || !S.draft.lines.length || mismatch !== 0 || Boolean(problem);
  for (const id of ["posFinish", "barFinish"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = blocked;
  }
  const draftBtn = document.getElementById("posDraft");
  if (draftBtn) draftBtn.disabled = saleBusy || !S.draft.lines.length || Boolean(problem);

  set("barTotal", eur(total));
  set("barCount", S.draft.lines.length + " rida · " + METHOD_LABEL[S.draft.method]);
}

// The invoice as the server wants it. Shared by every path that writes one, so
// a field added to a line is added in exactly one place.
const draftPayload = () => ({
  lines: S.draft.lines.map((l) => ({
    productId: l.productId,
    serviceId: l.serviceId,
    barberId: l.barberId,
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

// A failed call is either a dead session or something the user should read.
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      signOut("Sessioon aegus. Palun logi uuesti sisse.");
      return null;
    }
    toast(err.message || "Midagi läks valesti.");
    return null;
  }
}

// The one landing spot for every write. The server answers each one with the
// whole refreshed state, so nothing on screen can be left stale.
//
// On failure the screen is left alone by default, so whatever was typed into
// a form survives to be corrected. Inline edits (a checkbox, a price field)
// pass reset: true, so they snap back to what the server actually holds.
async function write(call, { tab = null, invoiceId = null, message = "", reset = false } = {}) {
  const result = await guard(call);
  if (!result) {
    if (reset) render();
    return null;
  }
  if (result.token) setToken(result.token);
  if (result.state) applyState(result.state);
  if (invoiceId) S.selectedInvoiceId = invoiceId;
  if (tab) S.tab = tab;
  render();
  const text = typeof message === "function" ? message(result) : message;
  if (text) toast(text);
  return result;
}

async function refreshFromServer() {
  const data = await guard(() => api.bootstrap());
  if (data) {
    applyState(data);
    render();
  }
}

// A sale in flight. The till's two finish buttons (panel and phone bar) and a
// double tap must not ring the same sale up twice.
let saleBusy = false;

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

  // ---- who is in the chair
  pickChair(barberId) {
    setActiveBarber(barberId);
    render();
  },

  // ---- the sale being rung up
  ringUp(service) {
    addLine(serviceLine(service));
    render();
  },

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

  // A second row of the same service, so it can be given its own price.
  duplicateLine(key) {
    duplicateLine(key);
    render();
  },

  // Picking a regular fills in the buyer block and drops their agreed prices
  // onto matching lines — and onto every line rung up after this.
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

  // Free text that no figure depends on, so nothing is repainted: a rebuild
  // here would pull the caret out of the field mid-word.
  setBuyer(patch) {
    Object.assign(S.draft, patch);
  },

  clearDraft() {
    clearDraft();
    render();
  },

  // Park the invoice without issuing it. No number is minted, nothing is
  // booked and no stock moves, so a consolidated invoice can be built up over
  // a week — and thrown away again without leaving a trace.
  async saveDraft() {
    if (!S.draft.lines.length || saleBusy) return;
    saleBusy = true;
    refreshTotals();
    const id = S.draft.editingId;
    const result = await guard(() =>
      id ? api.updateInvoice(id, draftPayload()) : api.createInvoice(draftPayload())
    );
    saleBusy = false;
    if (!result) return refreshTotals();
    clearDraft();
    applyState(result.state);
    S.selectedInvoiceId = result.invoice.id;
    S.tab = "inv";
    render();
    toast("Mustand salvestatud.");
  },

  async finishSale() {
    if (!S.draft.lines.length || saleBusy) return;
    saleBusy = true;
    refreshTotals();
    try {
      // Paid on the spot with no draft behind it: the till path, one call and
      // one transaction.
      if (!S.draft.editingId && S.draft.method !== "later") {
        const result = await guard(() =>
          api.createSale({
            date: todayISO(),
            ...draftPayload(),
            cash: parseNum(S.draft.cash),
            card: parseNum(S.draft.card),
          })
        );
        if (!result) return;
        clearDraft();
        applyState(result.state);
        S.selectedInvoiceId = result.invoice.id;
        S.tab = "inv";
        render();
        toast("Arve " + result.invoice.nr + " koostatud · kanne kassaraamatus");
        return;
      }

      // Otherwise it is a composed invoice: make sure the draft is saved,
      // then issue it. Issuing is the moment the number is minted and the
      // stock moves.
      let id = S.draft.editingId;
      if (id) {
        if (!(await guard(() => api.updateInvoice(id, draftPayload())))) return;
      } else {
        const created = await guard(() => api.createInvoice({ date: todayISO(), ...draftPayload() }));
        if (!created) return;
        // Keep hold of the draft: if issuing fails below, the next attempt
        // must update this one rather than create a second copy — and it is
        // already listed under Arved as a draft.
        id = S.draft.editingId = created.invoice.id;
        applyState(created.state);
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
      if (!issued) return;

      clearDraft();
      applyState(issued.state);
      S.selectedInvoiceId = issued.invoice.id;
      S.tab = "inv";
      render();
      toast(payNow
        ? "Arve " + issued.invoice.nr + " koostatud · kanne kassaraamatus"
        : "Arve " + issued.invoice.nr + " esitatud · maksmata, tähtaeg " + dateET(issued.invoice.due_date));
    } finally {
      saleBusy = false;
      if (S.tab === "pos") refreshTotals();
    }
  },

  // Reopen a saved draft in the till so more lines can be added to it.
  editDraft(invoice) {
    loadDraftFrom(invoice);
    S.tab = "pos";
    render();
    toast("Mustand avatud — lisa read ja esita arve, kui valmis.");
  },

  async deleteDraft(invoice) {
    if (!(await confirmAsk("Kustutada mustand?",
      "Numbrit pole eraldatud, laost pole midagi võetud ja kassaraamatusse pole midagi kirjutatud — midagi muud ei muutu.",
      { confirm: "Kustuta mustand", danger: true }))) return;
    const result = await write(() => api.deleteInvoice(invoice.id), { message: "Mustand kustutatud." });
    if (result && S.draft.editingId === invoice.id) clearDraft();
  },

  // The money finally arrived. This is what writes the cash-book entry for a
  // credit invoice — weeks after it was issued.
  async payInvoice(invoice) {
    const answer = await ask({
      title: "Arve " + invoice.nr + " makstud",
      message: eur(invoice.total) + " kirjutatakse kassaraamatusse valitud kuupäevaga.",
      fields: [
        { name: "method", label: "Kuidas maksti", value: "bank", options: [
          { value: "bank", label: "Ülekandega" },
          { value: "cash", label: "Sularahas" },
          { value: "card", label: "Kaardiga" },
        ] },
        { name: "date", label: "Laekumise kuupäev", type: "date", value: todayISO(), required: true },
      ],
      confirm: "Märgi makstuks",
    });
    if (!answer) return;
    const total = Number(invoice.total);
    const payment = { date: answer.date, cash: 0, card: 0, bank: 0 };
    payment[answer.method] = total;
    await write(() => api.payInvoice(invoice.id, payment), {
      invoiceId: invoice.id, message: "Arve " + invoice.nr + " makstud.",
    });
  },

  // Voiding keeps the number and undoes the cash-book entry and the stock
  // movements the sale created. The number has to be typed out and a reason
  // given — in one dialog, so backing out of it cannot leave half an answer.
  async cancelInvoice(invoice) {
    const answer = await ask({
      title: "Tühistada arve " + invoice.nr + "?",
      message: "Number jääb numbrireas alles. Kassakanne ja laoliikumine keeratakse tagasi.",
      fields: [
        { name: "nr", label: "Kinnitamiseks kirjuta arve number", match: invoice.nr, placeholder: invoice.nr },
        { name: "reason", label: "Tühistamise põhjus", required: true, maxlength: "300",
          placeholder: "Nt. vale klient, topeltmüük" },
      ],
      confirm: "Tühista arve",
      danger: true,
    });
    if (!answer) return;
    await write(() => api.cancelInvoice(invoice.id, answer.reason), {
      invoiceId: invoice.id, message: "Arve " + invoice.nr + " tühistatud · kassa ja ladu taastatud",
    });
  },

  async uncancelInvoice(invoice) {
    if (!(await confirmAsk("Võtta tühistamine tagasi?",
      "Arve " + invoice.nr + " taastatakse. Kassakanne ja laoliikumine tehakse uuesti.",
      { confirm: "Taasta arve" }))) return;
    await write(() => api.uncancelInvoice(invoice.id), {
      invoiceId: invoice.id, message: "Arve " + invoice.nr + " taastatud.",
    });
  },

  // Remove an invoice from the books for good. The dialog says which of the
  // two cases this is, because they have very different consequences.
  async purgeInvoice(invoice) {
    const last = isLastOfMonth(invoice);
    const answer = await ask({
      title: "Kustutada arve " + invoice.nr + " jäädavalt?",
      message: [
        "Rida kaob raamatust täielikult ja seda ei saa tagasi võtta.",
        isCancelled(invoice) ? "" : "Kassakanne ja laoliikumine keeratakse tagasi.",
        last
          ? "Number " + invoice.nr + " vabaneb ja antakse järgmisele arvele — numbriritta auku ei jää."
          : "HOIATUS: " + invoice.nr + " ei ole kuu viimane arve, nii et numbriritta jääb auk. " +
            "Seda tuleb raamatupidajale osata seletada. Tühistamine hoiaks numbri alles.",
        "Auditijälge jääb kirje: number, ostja, summa ja kuupäev.",
      ].filter(Boolean).join("\n\n"),
      fields: [{ name: "nr", label: "Kinnitamiseks kirjuta arve number", match: invoice.nr, placeholder: invoice.nr }],
      confirm: "Kustuta jäädavalt",
      danger: true,
    });
    if (!answer) return;
    const result = await write(() => api.purgeInvoice(invoice.id), {
      message: (r) => "Arve " + invoice.nr + " kustutatud" +
        (r.leavesGap ? " · numbriritta jäi auk" : " · number vabastatud"),
    });
    if (result && S.selectedInvoiceId === invoice.id) {
      S.selectedInvoiceId = null;
      render();
    }
  },

  // ---- paroolid
  async resetStaffPassword(user) {
    const answer = await ask({
      title: "Uus parool: " + (user.name || user.email),
      message: "Vana parool asendatakse ja kõik selle konto sessioonid lõpetatakse. " +
        "Anna uus parool töötajale edasi ja lase tal see ise vahetada.",
      fields: [{ name: "password", label: "Uus parool (vähemalt 8 tähemärki)", type: "password",
                 autocomplete: "new-password", minLength: 8, required: true }],
      confirm: "Vaheta parool",
    });
    if (!answer) return;
    await write(() => api.resetStaffPassword(user.id, answer.password), {
      tab: "admin", message: "Parool vahetatud: " + user.email,
    });
  },

  async changeMyPassword(form) {
    if (String(form.next || "").length < 8) return toast("Uus parool peab olema vähemalt 8 tähemärki.");
    if (form.next !== form.again) return toast("Uued paroolid ei klapi omavahel.");
    // Every other session of this account ends; this one carries on with the
    // token the server hands back (write() stores it).
    await write(() => api.changeMyPassword(form.current, form.next), {
      message: "Parool vahetatud. Teised seadmed peavad uuesti sisse logima.",
    });
  },

  // ---- kliendid
  openCustomer(id) {
    S.selectedCustomerId = id;
    render();
  },

  async addCustomer(form) {
    if (!String(form.name || "").trim()) return toast("Kliendi nimi puudub.");
    const result = await write(() => api.addCustomer(form), { tab: "cust", message: "Klient lisatud." });
    if (result) {
      S.selectedCustomerId = result.customer.id;
      render();
    }
  },

  async updateCustomer(customer, patch) {
    await write(() => api.updateCustomer(customer.id, patch), { reset: true, message: "Klient salvestatud." });
  },

  // An empty field clears the agreement rather than storing a zero, which
  // would mean the service is free for this customer.
  async setCustomerPrice(customerId, serviceId, value) {
    const price = String(value).trim() === "" ? null : parseNum(value);
    await write(() => api.setCustomerPrice(customerId, serviceId, price), {
      reset: true, message: price === null ? "Erihind eemaldatud." : "Erihind salvestatud.",
    });
  },

  async removeCustomer(customer) {
    if (!(await confirmAsk("Eemaldada klient " + customer.name + "?",
      "Varasemad arved jäävad puutumata.", { confirm: "Eemalda", danger: true }))) return;
    const result = await write(() => api.removeCustomer(customer.id), { message: "Klient eemaldatud." });
    if (result) {
      S.selectedCustomerId = null;
      render();
    }
  },

  // ---- kontod
  async addStaff(form) {
    if (!String(form.email || "").trim()) return toast("E-post puudub.");
    if (String(form.password || "").length < 8) return toast("Parool peab olema vähemalt 8 tähemärki.");
    await write(() => api.addStaff(form), { message: "Konto loodud — anna parool töötajale edasi." });
  },

  // The whole map is sent each time, so what the owner sees on screen is
  // exactly what the account ends up with.
  async setStaffPermission(user, area, value) {
    const next = Object.assign(permsOf(user), { [area]: Boolean(value) });
    await write(() => api.setStaffPermissions(user.id, next), {
      reset: true,
      message: (AREA_LABEL[area] || area) + (value ? " lubatud: " : " keelatud: ") + (user.name || user.email),
    });
  },

  async setStaffRole(user, role) {
    await write(() => api.updateStaff(user.id, { role }), { reset: true, message: "Roll salvestatud." });
  },

  // Closed, never deleted: invoices point at their creator.
  async closeStaff(user) {
    if (!(await confirmAsk("Sulgeda konto " + user.email + "?",
      "Ta ei saa enam sisse logida ja tema avatud sessioonid lõpetatakse. Tema arved jäävad alles.",
      { confirm: "Sulge konto", danger: true }))) return;
    await write(() => api.removeStaff(user.id), { message: "Konto suletud." });
  },

  async reopenStaff(user) {
    await write(() => api.updateStaff(user.id, { active: true }), { message: "Konto taasavatud." });
  },

  // ---- kassaraamat
  pickLedgerMonth(month) {
    S.ledgerMonth = month;
    render();
  },

  async addLedger(form) {
    await write(() =>
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
        // The form always had a transfer field; it was never sent.
        bank: parseNum(form.bank),
      }), { message: "Kanne lisatud." });
  },

  async deleteLedger(entry) {
    if (!(await confirmAsk("Kustutada kassaraamatu kanne?",
      dateET(entry.entry_date) + " · " + entry.category + (entry.description ? " · " + entry.description : "") +
        "\n\nKustutamine jääb auditijälge.",
      { confirm: "Kustuta", danger: true }))) return;
    await write(() => api.removeLedger(entry.id), { message: "Kanne kustutatud." });
  },

  exportLedger(month) {
    const rows = [["Kuupäev", "Tüüp", "Kategooria", "Kirjeldus", "Sularaha", "Kaart", "Ülekanne", "Summa"]];
    for (const e of S.ledger) {
      if (month && String(e.entry_date).slice(0, 7) !== month) continue;
      rows.push([
        dateET(e.entry_date), e.kind, e.category, e.description,
        num(e.cash), num(e.card), num(e.bank), num(entryAmount(e)),
      ]);
    }
    if (rows.length === 1) return toast("Sel kuul pole kandeid.");
    downloadCSV("kassaraamat-" + (month || todayISO()) + ".csv", rows);
    toast("CSV alla laaditud.");
  },

  // ---- ladu
  async addMovement(form) {
    if (!form.productId) return toast("Vali toode.");
    await write(() =>
      api.addMovement({
        date: form.date,
        productId: form.productId,
        type: form.type,
        qty: parseNum(form.qty),
        price: parseNum(form.price),
      }), { message: "Liikumine lisatud." });
  },

  // Typing a new stock figure books the difference as a movement, so the
  // shelf and the history never disagree.
  async setStock(product, qty) {
    await write(() => api.setStock(product.id, qty), {
      reset: true,
      message: (r) =>
        r.delta === 0 ? product.name + " — jääk oli juba " + qty + " tk."
        : r.delta > 0 ? product.name + " — lisatud " + r.delta + " tk, jääk " + qty + " tk."
        : product.name + " — maha kantud " + Math.abs(r.delta) + " tk, jääk " + qty + " tk.",
    });
  },

  async deleteMovement(movement) {
    if (!(await confirmAsk("Kustutada laoliikumine?",
      movement.product_name + " · " + (movement.move_type === "in" ? "sisse " : "välja ") +
        Number(movement.qty) + " tk · " + dateET(movement.move_date),
      { confirm: "Kustuta", danger: true }))) return;
    await write(() => api.removeMovement(movement.id), { message: "Liikumine kustutatud." });
  },

  // ---- hinnakiri
  async saveSettings(patch) {
    await write(() => api.saveSettings(patch), { reset: true, message: "Salvestatud." });
  },

  async createService(form) {
    if (!String(form.name || "").trim()) return toast("Teenuse nimi puudub.");
    await write(() => api.addService({ name: form.name, price: parseNum(form.price), note: form.note }), {
      message: "Teenus lisatud — iga barber pakub seda salongi hinnaga, kuni muudad.",
    });
  },

  async saveService(service, patch) {
    await write(() => api.updateService(service.id, patch), { reset: true, message: "Teenus salvestatud." });
  },

  async removeService(service) {
    if (!(await confirmAsk("Eemaldada teenus " + service.name + "?",
      "See kaob kassast ja hinnakirjast. Varasemad arved jäävad puutumata.",
      { confirm: "Eemalda", danger: true }))) return;
    await write(() => api.removeService(service.id), { message: "Teenus eemaldatud." });
  },

  async createProduct(form) {
    if (!String(form.name || "").trim()) return toast("Toote nimi puudub.");
    await write(() => api.addProduct({
      name: form.name, cost: parseNum(form.cost), price: parseNum(form.price), image_url: form.image_url,
    }), { message: "Toode lisatud — kanna kaup Lao alt sisse." });
  },

  async saveProduct(product, patch) {
    await write(() => api.updateProduct(product.id, patch), { reset: true, message: "Toode salvestatud." });
  },

  async removeProduct(product) {
    if (!(await confirmAsk("Eemaldada toode " + product.name + "?",
      "See kaob kassast ja laost. Varasemad arved ja liikumised jäävad alles.",
      { confirm: "Eemalda", danger: true }))) return;
    await write(() => api.removeProduct(product.id), { message: "Toode eemaldatud." });
  },

  // ---- kuu kokkuvõte
  pickReportMonth(month) {
    S.reportMonth = month;
    render();
  },

  exportMonth(month) {
    const rows = [["Kuu", "Barber", "Teenus", "Kogus", "Summa"]];
    for (const r of monthlyByBarber(month)) {
      for (const s of r.services) {
        rows.push([month, r.barber, s.name, String(Math.round(s.qty * 100) / 100), num(s.gross)]);
      }
      rows.push([month, r.barber, "KOKKU", String(Math.round(r.qty * 100) / 100), num(r.gross)]);
    }
    if (rows.length === 1) return toast("Sel kuul pole midagi eksportida.");
    downloadCSV("kuu-kokkuvote-" + month + ".csv", rows);
    toast("CSV alla laaditud.");
  },

  // ---- barberid
  // Which chair a login belongs to. Setting it gives that account its own
  // prices under Hinnakiri and locks the till to that one barber.
  async linkBarber(user, barberId) {
    // The link is stored on the barber, so clearing it means detaching
    // whichever barber currently points at this account.
    const current = S.barbers.find((b) => b.account_id === user.id);
    const target = barberId || (current && current.id);
    if (!target) return;
    await write(() => api.updateBarber(target, { accountId: barberId ? user.id : null }), {
      reset: true,
      message: (r) => barberId ? user.email + " → " + r.barber.name : "Seos eemaldatud: " + user.email,
    });
  },

  pickBarber(id) {
    S.selectedBarberId = id;
    render();
  },

  async setBarberPrice(barber, service, price, offered) {
    S.selectedBarberId = barber.id;
    await write(() => api.setBarberPrice(barber.id, service.id, price, offered), {
      reset: true,
      message: offered
        ? barber.name + " · " + service.name + " " + eur(price)
        : barber.name + " ei paku: " + service.name,
    });
  },

  async createBarber(form) {
    if (!String(form.name || "").trim()) return toast("Barberi nimi puudub.");
    const result = await write(() => api.addBarber(form), {
      message: "Barber lisatud — alustab salongi hinnakirjaga.",
    });
    if (result) {
      S.selectedBarberId = result.barber.id;
      render();
    }
  },

  async saveBarber(barber, patch) {
    await write(() => api.updateBarber(barber.id, patch), { reset: true, message: "Barber salvestatud." });
  },

  async removeBarber(barber) {
    if (!(await confirmAsk("Eemaldada barber " + barber.name + "?",
      "Ta kaob kassa valikust. Tema varasemad arveread ja kuu kokkuvõte jäävad alles.",
      { confirm: "Eemalda", danger: true }))) return;
    const result = await write(() => api.removeBarber(barber.id), { message: "Barber eemaldatud." });
    if (result) {
      S.selectedBarberId = null;
      render();
    }
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
  S.me = null;
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
  restoreActiveBarber();

  if (!getToken()) {
    showLogin("");
    return;
  }

  // One call: the bootstrap both proves the token and loads the till. An
  // expired or revoked token drops straight to the login form.
  try {
    const data = await api.bootstrap();
    S.me = data.me;
    S.user = data.me;
    applyState(data);
    showApp();
    render();
  } catch (err) {
    // No connection is not a dead session: keep the token so a reload once
    // the network is back goes straight into the till.
    if (err instanceof ApiError && err.status === 0) showLogin(err.message);
    else signOut("");
  }
}

boot();
