// views.js — every screen, as functions that return DOM nodes.
// Views read from state.js and call back into the `actions` object that
// main.js passes in; they never talk to the server themselves.

import {
  h, panel, eur, num, signed, dateET, dateTimeET, dayMonth, todayISO, monthLabel, parseNum,
} from "./util.js";
import {
  S, draftVat, paymentMismatch, draftProblem, draftTotal, METHOD_LABEL, UNITS,
  ledgerWithBalance, ledgerTotals, ledgerMonths, dayFigures, stockValue, lowStock, lowLimit,
  stockStatus, isCancelled, lineTotal, isDraft, isUnpaid, statusLabel, unpaidInvoices, unpaidTotal,
  isOwner, can, pastBuyers, AREAS, AREA_LABEL, permsOf,
  myBarber, barberById, barberPrice, activeBarber, lockedBarber, tileFor,
  monthlyByBarber, invoiceMonths,
} from "./state.js";

// Offered in the cash-book dropdown; categories already used join the list.
const LEDGER_CATEGORIES = ["Teenuste müük", "Kaubamüük", "Kaubavaru", "Rent", "Töövahendid", "Palk"];

// Helper text under a form or table.
const note = (text, style = "") =>
  h("p", { class: "lab hint", style, text });

// ------------------------------------------------------------- fragments

function head(eyebrow, title, ...actions) {
  return h("div", { class: "head" },
    h("div", {},
      h("p", { class: "eyebrow", text: eyebrow, style: "margin:0" }),
      h("h1", { class: "h1", text: title })
    ),
    actions.length ? h("div", { class: "headacts noprint" }, ...actions) : null
  );
}

function kpi(label, value, opts = {}) {
  return h("div", { class: "kpi" + (opts.inverse ? " inv" : "") },
    h("p", { class: "thr", text: label, style: "margin:0" }),
    h("p", { class: "stat" + (opts.cls ? " " + opts.cls : ""), text: value, style: "margin:0" })
  );
}

function table(cols, headers, rows, emptyText) {
  const grid = "grid-template-columns:" + cols;
  // The scroller keeps a wide table inside itself instead of pushing the
  // whole page sideways on a phone.
  return h("div", { class: "tblwrap" },
    h("div", { class: "tbl" },
      h("div", { class: "hrow", style: grid },
        ...headers.map((t) => h("span", { class: "thr" + (t.r ? " r" : ""), text: t.label || t }))
      ),
      rows.length ? rows : h("p", { class: "empty", text: emptyText })
    )
  );
}

const field = (label, input) => h("label", { class: "fld" }, h("span", { class: "lab", text: label }), input);

const inp = (attrs) => h("input", { class: "inp", ...attrs });

function select(attrs, options, current) {
  return h("select", { class: "inp", ...attrs },
    ...options.map((o) => {
      const value = typeof o === "string" ? o : o.value;
      const label = typeof o === "string" ? o : o.label;
      return h("option", { value, selected: String(value) === String(current) }, label);
    })
  );
}

// ---------------------------------------------------------------- töölaud

export function viewDash(actions) {
  const day = dayFigures();
  const totals = ledgerTotals();
  const low = lowStock();

  return [
    head(dateET(todayISO()), "Töölaud",
      h("button", { class: "btng", type: "button", onclick: () => actions.goto("stock") }, "Ladu"),
      h("button", { class: "btnp", type: "button", onclick: () => actions.goto("pos") }, "+ Uus müük")
    ),

    h("div", { class: "grid4" },
      kpi("Päeva käive", eur(day.turnover)),
      kpi("Sularaha + kaart", eur(day.cash + day.card)),
      // Money owed belongs on the first screen: an unpaid consolidated invoice
      // is invisible everywhere else until someone goes looking for it.
      kpi("Maksmata arved", eur(unpaidTotal()),
        { cls: unpaidTotal() > 0 ? "warnc" : "" }),
      kpi("Kassa jääk", eur(totals.balance), { inverse: true })
    ),

    h("div", { class: "cols c2" },
      panel({},
        h("p", { class: "thr", text: "Tänased arved", style: "margin:0 0 12px" }),
        day.invoices.length
          ? h("div", {},
              ...day.invoices.map((i) =>
                h("div", { class: "row click", style: "grid-template-columns:1fr auto",
                           onclick: () => actions.openInvoice(i.id) },
                  h("span", { class: "tr", text: i.nr + " · " + lineSummary(i) }),
                  h("span", { class: "tr mono r", text: eur(i.total) })
                )
              )
            )
          : h("p", { class: "empty", text: "Täna pole veel ühtegi müüki." }),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:14px 0 0;line-height:1.5" },
          "Iga lõpetatud müük kirjutab arve, kassaraamatu kande ja laoliikumise ühe vajutusega.")
      ),

      panel({},
        h("p", { class: "thr", text: "Ladu", style: "margin:0 0 12px" }),
        h("div", { style: "display:flex;justify-content:space-between;gap:12px;padding:5px 0" },
          h("span", { class: "tr", text: "Lao väärtus" }),
          h("span", { class: "tr mono", text: eur(stockValue()) })
        ),
        h("div", { style: "display:flex;justify-content:space-between;gap:12px;padding:5px 0" },
          h("span", { class: "tr", text: "Tellida juurde" }),
          h("span", { class: "tr mono warnc", text: low.length + " artiklit" })
        ),
        h("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:14px" },
          ...low.map((p) =>
            h("div", { class: "chip" + (Number(p.stock) <= 0 ? " zero" : "") },
              h("span", { text: p.name }),
              h("span", { class: "mono" + (Number(p.stock) <= 0 ? " neg" : " warnc"), text: String(Number(p.stock)) })
            )
          ),
          low.length ? null : h("p", { class: "empty", text: "Kõik tooted on varus." })
        )
      )
    ),
  ];
}

const lineSummary = (invoice) =>
  (invoice.lines || []).map((l) => l.name).join(", ").slice(0, 60) || invoice.buyer_name;

// --------------------------------------------------------------- kiirmüük

// The server allocates the real number when the sale is finished; this is the
// number it will almost certainly get, shown so the operator can quote it.
// Format is MMYY-NNN and the counter restarts every month.
function expectedNr() {
  const [yyyy, mm] = todayISO().split("-");
  const prefix = mm + yyyy.slice(2) + "-";
  const seqs = S.invoices
    .filter((i) => String(i.nr).startsWith(prefix))
    .map((i) => Number(String(i.nr).split("-")[1]) || 0);
  return prefix + String((seqs.length ? Math.max(...seqs) : 0) + 1).padStart(3, "0");
}

export function viewPos(actions) {
  const vat = draftVat();
  const total = draftTotal();
  const mismatch = paymentMismatch();
  const problem = draftProblem();
  const askTip = !(S.settings && S.settings.ask_tip === false);
  const showVat = !(S.settings && S.settings.show_vat === false);

  // Each tile shows what the barber in the chair charges. A treatment they
  // do not perform is struck through and cannot be rung up under their name.
  const chair = activeBarber();
  const serviceCards = S.services.map((s) => {
    const tile = tileFor(s);
    return h("button", {
      class: "svc" + (tile.offered ? "" : " unavail"), type: "button",
      disabled: !tile.offered,
      title: tile.offered ? null : chair.name + " seda teenust ei paku",
      onclick: tile.offered ? () => actions.ringUp(s) : null,
    },
      h("span", { class: "svcn", text: s.name }),
      h("span", { class: "svcp", text: tile.offered ? eur(tile.price) : "—" }),
      s.note ? h("span", { class: "svcm", text: s.note }) : null
    );
  });

  const productCards = S.products.map((p) => {
    const out = Number(p.stock) <= 0;
    return h("button", {
      class: "svc prod" + (out ? " out" : ""), type: "button", disabled: out,
      onclick: out ? null : () => actions.addLine({ productId: p.id, name: p.name, price: Number(p.price) }),
    },
      p.image_url
        ? h("img", { class: "prodimg", src: p.image_url, alt: "", loading: "lazy" })
        : null,
      h("div", { class: "svcrow" },
        h("span", { class: "svcn", text: p.name }),
        h("span", { class: "svcp", text: num(p.price) })
      ),
      h("span", { class: "svcm" + (out ? " neg" : Number(p.stock) <= lowLimit() ? " warnc" : ""),
                  text: out ? "Otsas" : "Jääk " + Number(p.stock) })
    );
  });

  // A line is collapsed by default and looks exactly as it always has, so the
  // till stays a three-tap job. Everything that makes a line flexible — its
  // name on this invoice, a description, the unit, a discount — lives behind
  // the expander, where it costs nothing to anyone who does not need it.
  const draftRows = S.draft.lines.map((l) => {
    const discounted = Number(l.discount) > 0;
    const sub = [
      l.note,
      discounted ? "−" + num(l.discount).replace(",00", "") + "% · " + eur(lineTotal(l)) : null,
    ].filter(Boolean).join(" · ");

    return h("div", { class: "dline" + (l.open ? " open" : "") + (Number(l.qty) > 0 ? "" : " bad") },
      h("button", {
        class: "dname", type: "button", title: "Ava rida",
        onclick: () => actions.toggleLine(l.key),
      }, l.name),
      inp({ type: "number", min: "0", step: "1", value: String(l.qty),
            "aria-label": "Kogus", oninput: (e) => actions.updateLine(l.key, { qty: parseNum(e.target.value) }) }),
      inp({ type: "number", min: "0", step: "0.01", value: String(l.price),
            "aria-label": "Hind", oninput: (e) => actions.updateLine(l.key, { price: parseNum(e.target.value) }) }),
      h("button", { class: "dexp", type: "button",
                    title: l.open ? "Sulge rida" : "Muuda nime, selgitust, allahindlust",
                    "aria-expanded": String(Boolean(l.open)),
                    onclick: () => actions.toggleLine(l.key) }, l.open ? "⌃" : "⌄"),
      h("button", { class: "del", type: "button", title: "Eemalda rida",
                    onclick: () => actions.removeLine(l.key) }, "×"),

      sub && !l.open ? h("span", { class: "dsub", text: sub }) : null,

      l.open
        ? h("div", { class: "dopen" },
            field("Nimi arvel", inp({
              type: "text", value: l.name, maxlength: "200", autocomplete: "off",
              oninput: (e) => actions.updateLine(l.key, { name: e.target.value }),
            })),
            field("Selgitus arvel", inp({
              type: "text", value: l.note, maxlength: "300", autocomplete: "off",
              placeholder: "Nt. nädala koondarve · kokkulepitud hind",
              oninput: (e) => actions.updateLine(l.key, { note: e.target.value }),
            })),
            h("div", { class: "formrow" },
              field("Kogus", inp({ type: "number", min: "0", step: "0.5", value: String(l.qty),
                oninput: (e) => actions.updateLine(l.key, { qty: parseNum(e.target.value) }) })),
              field("Ühik", select({ onchange: (e) => actions.updateLine(l.key, { unit: e.target.value }) },
                UNITS, l.unit)),
              field("Ühikuhind", inp({ type: "number", min: "0", step: "0.01", value: String(l.price),
                oninput: (e) => actions.updateLine(l.key, { price: parseNum(e.target.value) }) })),
              field("Allahindlus %", inp({ type: "number", min: "0", max: "100", step: "1",
                value: String(l.discount),
                oninput: (e) => actions.updateLine(l.key, { discount: parseNum(e.target.value) }) }))
            ),
            h("div", { class: "dfoot" },
              h("span", { class: "lab", text: "Rea summa" }),
              h("span", { class: "tr mono", id: "dsum" + l.key, text: eur(lineTotal(l)) }),
              h("button", { class: "btng sm", type: "button",
                            title: "Sama teenus veel kord, oma hinnaga",
                            onclick: () => actions.duplicateLine(l.key) }, "Tee koopia")
            )
          )
        : null
    );
  });

  return [
    head(
      (S.draft.editingId ? "Mustandi muutmine" : "Uus arve · " + expectedNr()) +
        (chair ? " · " + chair.name : ""),
      S.draft.editingId ? "Koondarve" : "Kiirmüük",
      h("button", { class: "btng", type: "button", onclick: actions.clearDraft },
        S.draft.editingId ? "Loobu muutmisest" : "Tühjenda")
    ),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        panel({},
          chairPicker(actions),
          h("p", { class: "thr", text: "Teenused · kliki, et lisada rida", style: "margin:0 0 12px" }),
          h("div", { class: "cardgrid" }, ...serviceCards)
        ),
        panel({},
          h("p", { class: "thr", text: "Tooted laost · jääk uueneb müügiga", style: "margin:0 0 12px" }),
          S.products.length
            ? h("div", { class: "cardgrid" }, ...productCards)
            : h("p", { class: "empty", text: "Tooteid pole. Lisa need Hinnakirja alt." })
        )
      ),

      panel({},
        h("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:12px" },
          h("p", { class: "thr", text: "Arve mustand", style: "margin:0" }),
          // A number is minted at issue time, never before — so a draft that is
          // never issued cannot leave a gap in the sequence.
          h("p", { class: "thr", style: "margin:0",
                   text: S.draft.editingId || S.draft.method === "later"
                     ? "nr eraldatakse esitamisel"
                     : expectedNr() })
        ),

        h("p", { class: "thr", text: "Ostja", style: "margin:14px 0 8px" }),
        h("div", { style: "display:flex;flex-direction:column;gap:10px" },
          S.customers.length
            ? field("Salvestatud klient", select(
                { onchange: (e) => actions.pickCustomer(e.target.value ? Number(e.target.value) : null) },
                [{ value: "", label: "— vali klient, hinnad täidetakse —" },
                 ...S.customers.map((c) => ({ value: c.id, label: c.name }))],
                S.draft.customerId || ""
              ))
            : null,
          field("Nimi või ettevõte", inp({
            id: "posBuyerName", type: "text", value: S.draft.buyerName,
            placeholder: "Eraklient", autocomplete: "off", maxlength: "200",
            list: "buyerNames",
            oninput: (e) => actions.setBuyer({ buyerName: e.target.value }),
          })),
          // Names already used, so a regular does not have to be retyped.
          h("datalist", { id: "buyerNames" },
            ...pastBuyers().map((n) => h("option", { value: n }))),
          field("Registrikood, aadress või e-post", inp({
            id: "posBuyerDetails", type: "text", value: S.draft.buyerDetails,
            placeholder: "Nt. 12345678 · Aardla 130, Tartu", autocomplete: "off", maxlength: "500",
            oninput: (e) => actions.setBuyer({ buyerDetails: e.target.value }),
          }))
        ),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:8px 0 0;line-height:1.5",
                 text: "Täida ainult siis, kui arve peab olema kellegi nimel. Muidu läheb arvele Eraklient." }),

        h("div", { style: "margin-top:12px" },
          draftRows.length ? draftRows : h("p", { class: "empty", text: "Vali vasakult teenus või toode." })
        ),

        askTip
          ? h("div", { class: "dline" },
              h("span", { class: "tr dim", text: "Jootraha (KM-vaba)" }),
              h("span", {}),
              inp({ type: "number", min: "0", step: "0.5", value: String(S.draft.tip),
                    "aria-label": "Jootraha", oninput: (e) => actions.setTip(parseNum(e.target.value)) }),
              h("span", {})
            )
          : null,

        showVat
          ? h("div", { style: "margin-top:12px;display:flex;flex-direction:column;gap:4px" },
              totalRow("Ilma KM", num(vat.net), "posNet"),
              totalRow("KM " + num(vat.rate).replace(",00", "") + "%", num(vat.vat), "posVat")
            )
          : null,

        h("div", { class: "tot", style: "margin-top:12px" },
          h("span", { text: "Tasuda" }),
          h("span", { id: "posTotal", text: eur(total) })
        ),

        h("p", { class: "thr", text: "Makseviis", style: "margin:16px 0 8px" }),
        // "Hiljem" is the one that makes a consolidated invoice possible: the
        // document goes out now and the money arrives by transfer later.
        h("div", { class: "seg" },
          ...[["cash", "Sularaha"], ["card", "Kaart"], ["split", "Jaga"], ["later", "Hiljem"]]
            .map(([value, label]) =>
              h("button", {
                type: "button", class: S.draft.method === value ? "on" : "",
                "aria-pressed": String(S.draft.method === value),
                onclick: () => actions.setMethod(value),
              }, label)
            )
        ),

        S.draft.method === "later"
          ? h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:10px 0 0;line-height:1.5" },
              "Arve esitatakse maksmata. Kassaraamatu kanne tekib alles siis, kui märgid arve makstuks.")
          : null,

        S.draft.method === "later"
          ? null
          : h("div", { class: "formrow", style: "margin-top:10px" },
              field("Sularahas", inp({ id: "posCash", type: "number", min: "0", step: "0.01",
                value: String(S.draft.cash), disabled: S.draft.method !== "split",
                oninput: (e) => actions.setPayment({ cash: parseNum(e.target.value) }) })),
              field("Kaardiga", inp({ id: "posCard", type: "number", min: "0", step: "0.01",
                value: String(S.draft.card), disabled: S.draft.method !== "split",
                oninput: (e) => actions.setPayment({ card: parseNum(e.target.value) }) }))
            ),

        h("p", { id: "posErr", class: "err", style: "margin:10px 0 0" },
          problem || (S.draft.lines.length && mismatch !== 0
            ? "Vahe " + num(Math.abs(mismatch) / 100) + " € — sularaha ja kaart kokku peavad võrduma summaga."
            : "")),

        // Two ways out of the till. Saving a draft mints no number and books
        // nothing, so a consolidated invoice can be built up over a week and
        // thrown away without leaving a hole in the sequence.
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" },
          h("button", {
            id: "posDraft", class: "btng", type: "button", style: "flex:1 1 150px",
            disabled: !S.draft.lines.length || Boolean(problem),
            onclick: actions.saveDraft,
          }, S.draft.editingId ? "Salvesta mustand" : "Salvesta mustandina"),
          h("button", {
            id: "posFinish", class: "btnp", type: "button", style: "flex:2 1 180px",
            disabled: !S.draft.lines.length || mismatch !== 0 || Boolean(problem),
            onclick: actions.finishSale,
          }, S.draft.method === "later" ? "Esita arve" : "Lõpeta müük")
        )
      )
    ),

    h("div", { class: "paybarfix noprint" },
      h("div", {},
        h("span", { id: "barCount", class: "cnt",
                    text: S.draft.lines.length + " rida · " + METHOD_LABEL[S.draft.method] }),
        h("span", { id: "barTotal", class: "sum", text: eur(total) })
      ),
      h("button", {
        id: "barFinish", class: "btnp", type: "button",
        disabled: !S.draft.lines.length || mismatch !== 0 || Boolean(problem),
        onclick: actions.finishSale,
      }, "Lõpeta")
    ),
  ];
}

// Who is in the chair. The price on every service tile, and the name written
// under each line, follow this. A barber's own login is tied to their chair
// and sees only their name here.
function chairPicker(actions) {
  if (!S.barbers.length) return null;
  const locked = lockedBarber();
  const chair = activeBarber();
  return h("div", { class: "chair" },
    h("p", { class: "thr", text: "Kassas", style: "margin:0" }),
    locked
      ? h("span", { class: "pill pos", text: locked.name })
      : h("div", { class: "chairs", role: "radiogroup", "aria-label": "Barber" },
          ...S.barbers.map((b) =>
            h("button", {
              type: "button", role: "radio",
              class: "chairbtn" + (chair && chair.id === b.id ? " on" : ""),
              "aria-checked": String(Boolean(chair && chair.id === b.id)),
              title: b.tier || null,
              onclick: () => actions.pickChair(b.id),
            }, b.name)
          )
        )
  );
}

const totalRow = (label, value, id) =>
  h("div", { style: "display:flex;justify-content:space-between;gap:12px" },
    h("span", { class: "thr", text: label }),
    h("span", { id, class: "mono", style: "font-size:12px;color:var(--tx2)", text: value })
  );

// ------------------------------------------------------------------ arved

export function viewInvoices(actions) {
  const selected = S.invoices.find((i) => i.id === S.selectedInvoiceId) || S.invoices[0] || null;

  const owed = unpaidInvoices();

  const rows = S.invoices.map((i) => {
    const st = statusLabel(i);
    return h("div", {
      class: "row click" + (selected && i.id === selected.id ? " sel" : ""),
      style: "grid-template-columns:1fr auto",
      onclick: () => actions.openInvoice(i.id),
    },
      h("div", {},
        h("div", { class: "tr mono" },
          isDraft(i) ? "mustand" : i.nr,
          // Every invoice now carries its state, so "issued but unpaid" can
          // never be mistaken for money already in the till.
          i.status === "makstud"
            ? null
            : h("span", { class: "pill " + st.cls, style: "margin-left:8px", text: st.label })
        ),
        h("div", { class: "thr", style: "margin-top:3px",
                   text: dateET(i.invoice_date) + " · " + lineSummary(i) +
                         (i.created_by_name ? " · " + i.created_by_name : "") })
      ),
      h("span", { class: "tr mono r" + (isCancelled(i) ? " dim struck" : ""), text: eur(i.total) })
    );
  });

  // What the shop is owed. Without this an unpaid consolidated invoice can sit
  // for two months without anyone noticing.
  const owedBanner = owed.length
    ? h("div", { class: "chip", style: "margin-bottom:12px" },
        h("span", { text: "Maksmata arveid: " + owed.length }),
        h("span", { class: "mono warnc", text: eur(unpaidTotal()) })
      )
    : null;

  const acts = [
    h("button", { class: "btng", type: "button", disabled: !selected || isDraft(selected),
                  onclick: () => window.print() }, "Trüki / PDF"),
  ];

  if (selected && isDraft(selected)) {
    acts.push(
      h("button", { class: "btng", type: "button",
                    onclick: () => actions.editDraft(selected) }, "Muuda"),
      // A draft is not a document: no number, nothing booked. Deleting one is
      // therefore harmless and needs no special right.
      h("button", { class: "btng", type: "button",
                    onclick: () => actions.deleteDraft(selected) }, "Kustuta mustand")
    );
  } else if (selected && isUnpaid(selected) && isOwner()) {
    acts.push(
      h("button", { class: "btnp", type: "button",
                    onclick: () => actions.payInvoice(selected) }, "Märgi makstuks")
    );
  }

  // Cancelling and deleting follow the "Arvete kustutamine" switch, which
  // every barber has unless the owner turned it off.
  if (selected && !isDraft(selected) && can("void")) {
    acts.push(
      isCancelled(selected)
        ? h("button", { class: "btng", type: "button",
                        onclick: () => actions.uncancelInvoice(selected) }, "Võta tühistamine tagasi")
        : h("button", { class: "btng", type: "button",
                        onclick: () => actions.cancelInvoice(selected) }, "Tühista arve"),
      // Offered on any issued invoice, cancelled or not — the warning about
      // the gap it may leave belongs in the confirmation, not in a button that
      // quietly refuses to appear.
      h("button", { class: "btng", type: "button",
                    onclick: () => actions.purgeInvoice(selected) }, "Kustuta jäädavalt")
    );
  }

  acts.push(h("button", { class: "btnp", type: "button", onclick: () => actions.goto("pos") }, "+ Uus müük"));

  return [
    head(S.invoices.length + " arvet", "Arved", ...acts),

    h("div", { class: "cols cinv" },
      h("div", { class: "noprint" },
        owedBanner,
        table("1fr auto", ["Arve", { label: "Summa", r: true }], rows, "Arveid veel pole."),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
          can("void")
            ? "Arve avaneb kõrval A4 lehena. Trüki / PDF saadab printi ainult lehe, ilma liideseta."
            : "Arve avaneb kõrval A4 lehena. Esitatud arvete tühistamine ja kustutamine " +
              "ei ole sinu kontole lubatud.")
      ),
      selected
        ? h("div", { class: "stack" },
            // An invoice that asks for a transfer but names no account cannot
            // be paid. Said here, on screen only — never printed.
            (isUnpaid(selected) || isDraft(selected)) && !(S.settings && S.settings.company_iban)
              ? h("div", { class: "chip noprint" },
                  h("span", { text: "Arvel pole IBAN-it — lisa see Hinnakirja alt „Arve päis ja kassa“." }))
              : null,
            invoiceSheet(selected))
        : h("p", { class: "empty", text: "Vali arve." })
    ),
  ];
}

function invoiceSheet(invoice) {
  const st = S.settings || {};
  const showVat = st.show_vat !== false && Number(invoice.vat_rate) > 0;

  const sellerLines = [
    st.company_name + (st.company_address ? " · " + st.company_address : ""),
    [st.company_reg && "Reg. " + st.company_reg, st.company_kmkr && "KMKR " + st.company_kmkr]
      .filter(Boolean).join(" · "),
    [st.company_bank, st.company_iban].filter(Boolean).join(" · "),
    [st.company_phone, st.company_email, st.company_web].filter(Boolean).join(" · "),
  ].filter((l) => l && l.trim());

  return h("article", { class: "a4" },
    h("span", { class: "mk tl", text: "+" }), h("span", { class: "mk tr", text: "+" }),
    h("span", { class: "mk bl", text: "+" }), h("span", { class: "mk br", text: "+" }),

    h("div", { class: "a4h" },
      h("img", { class: "a4logo", src: "assets/fi-logo.webp", alt: "Fi Barbershop" }),
      h("div", {},
        h("p", { class: "a4t", text: isDraft(invoice) ? "Mustand" : "Arve" }),
        h("p", { class: "a4nr", text: isDraft(invoice) ? "number eraldamata" : invoice.nr }),
        h("div", { class: "a4meta" },
          h("div", { text: "Kuupäev " + dateET(invoice.invoice_date) }),
          h("div", { text: "Tähtaeg " + dateET(invoice.due_date) }),
          // A draft has no number yet, so it has no reference number either —
          // printing the label with nothing after it just looks broken.
          invoice.reference ? h("div", { text: "Viitenumber " + invoice.reference }) : null
        )
      )
    ),

    isCancelled(invoice)
      ? h("p", { class: "a4void", text: "Tühistatud " + dateTimeET(invoice.cancelled_at).slice(0, 10) +
                 (invoice.cancel_reason ? " · " + invoice.cancel_reason : "") })
      : null,

    h("div", { class: "a4party" }, ...sellerLines.map((l) => h("div", { text: l }))),
    h("hr", { class: "a4rule" }),

    h("p", { class: "thr", style: "margin:16px 0 4px", text: "Ostja" }),
    h("p", { class: "a4pn", style: "margin:0", text: invoice.buyer_name }),
    invoice.buyer_details ? h("p", { class: "a4party", style: "margin:2px 0 0", text: invoice.buyer_details }) : null,

    h("div", { style: "margin-top:22px" },
      h("div", { class: "hrow", style: "grid-template-columns:1fr 60px 60px 90px 90px" },
        h("span", { class: "thr", text: "Kirjeldus" }),
        h("span", { class: "thr r", text: "Kogus" }),
        h("span", { class: "thr r", text: "Ühik" }),
        h("span", { class: "thr r", text: "Hind" }),
        h("span", { class: "thr r", text: "Summa" })
      ),
      ...(invoice.lines || []).map((l) => {
        const off = Number(l.discount) > 0;
        return h("div", { class: "row a4line", style: "grid-template-columns:1fr 60px 60px 90px 90px" },
          h("span", { class: "tr" },
            l.name,
            // The description is what makes an invoice readable a month later:
            // "Juukselõikus" alone does not say which haircut, or why 40 €.
            l.note ? h("span", { class: "a4note", text: l.note }) : null
          ),
          h("span", { class: "tr mono r", text: String(Number(l.qty)) }),
          h("span", { class: "tr mono r", text: l.unit }),
          h("span", { class: "tr mono r" },
            num(l.price),
            off ? h("span", { class: "a4off", text: "−" + num(l.discount).replace(",00", "") + "%" }) : null
          ),
          h("span", { class: "tr mono r", text: num(lineTotal(l)) })
        );
      })
    ),

    h("div", { class: "a4tot" },
      showVat ? h("div", { class: "a4tr" },
        h("span", { text: "Summa ilma KM" }), h("span", { text: num(invoice.net) })) : null,
      showVat ? h("div", { class: "a4tr" },
        h("span", { text: "Käibemaks " + num(invoice.vat_rate).replace(",00", "") + "%" }),
        h("span", { text: num(invoice.vat) })) : null,
      Number(invoice.tip) > 0 ? h("div", { class: "a4tr tip" },
        h("span", { text: "Jootraha (KM-vaba)" }), h("span", { text: num(invoice.tip) })) : null,
      h("div", { class: "a4g" },
        h("span", { text: "Tasuda kokku" }),
        h("span", { class: "mono", text: eur(invoice.total) })
      )
    ),

    h("div", { class: "a4foot" },
      h("div", { class: "thr", text: "Makse" }),
      // An unpaid invoice must say so on the page itself: printing one that
      // reads "Sularaha 0,00 · Kaart 0,00" tells the customer nothing.
      isUnpaid(invoice) || isDraft(invoice)
        ? h("div", { text: "Palume tasuda ülekandega hiljemalt " + dateET(invoice.due_date) +
            (st.company_iban ? " arveldusarvele " + st.company_iban : "") +
            (invoice.reference ? ", viitenumber " + invoice.reference : "") + "." })
        : h("div", {
            text: [
              Number(invoice.cash) ? "Sularaha " + num(invoice.cash) : null,
              Number(invoice.card) ? "Kaart " + num(invoice.card) : null,
              Number(invoice.bank) ? "Ülekanne " + num(invoice.bank) : null,
            ].filter(Boolean).join(" · ") || "Tasutud",
          }),
      isUnpaid(invoice) || isDraft(invoice) ? null : h("div", { text: "Arve on tasutud. Aitäh!" })
    )
  );
}

// ------------------------------------------------------------ kassaraamat

export function viewLedger(actions) {
  // The book is shown a month at a time; the balance column still runs over
  // the whole book, because the drawer does not empty on the first.
  const months = ledgerMonths();
  const month = S.ledgerMonth === "" ? ""
    : months.includes(S.ledgerMonth) ? S.ledgerMonth : todayISO().slice(0, 7);
  const totals = ledgerTotals(month);
  const rows = ledgerWithBalance().filter((e) => !month || String(e.entry_date).slice(0, 7) === month);
  const grid = "70px 62px 1fr 1.5fr 80px 80px 84px 92px 92px 28px";

  const form = {
    date: todayISO(), kind: "kulu", category: "Muu", custom: "", description: "",
    cash: "", card: "", bank: "",
  };

  // Categories already used in the book join the list, so a name typed once
  // does not have to be retyped every month.
  const used = [...new Set(S.ledger.map((e) => e.category).filter(Boolean))];
  const options = [...new Set([...LEDGER_CATEGORIES, ...used])].filter((c) => c !== "Muu");
  options.push("Muu");

  const customField = field("Täpsusta kategooria",
    inp({ type: "text", placeholder: "Nt. koolitus, parkimine",
          oninput: (e) => (form.custom = e.target.value) }));
  customField.hidden = form.category !== "Muu";

  const body = rows.map((e) =>
    h("div", { class: "row", style: "grid-template-columns:" + grid },
      h("span", { class: "tr mono", text: dayMonth(e.entry_date) }),
      h("span", { class: "pill " + (e.kind === "tulu" ? "pos" : "neg"), text: e.kind }),
      h("span", { class: "tr", text: e.category }),
      h("span", { class: "tr", text: e.description }),
      h("span", { class: "tr mono r", text: Number(e.cash) ? num(e.cash) : "–" }),
      h("span", { class: "tr mono r", text: Number(e.card) ? num(e.card) : "–" }),
      h("span", { class: "tr mono r", text: Number(e.bank) ? num(e.bank) : "–" }),
      h("span", { class: "tr mono r " + (e.amount >= 0 ? "pos" : "neg"), text: signed(e.amount) }),
      h("span", { class: "tr mono r dim", text: num(e.balance) }),
      e.invoice_id
        ? h("span", { class: "thr r", title: "Tuli arvest", text: "·" })
        : h("button", { class: "del", type: "button", title: "Kustuta kanne",
                        onclick: () => actions.deleteLedger(e) }, "×")
    )
  );

  return [
    head(month ? monthLabel(month + "-01") : "Kogu raamat", "Kassaraamat",
      select({ style: "width:auto;min-width:150px", "aria-label": "Kuu",
               onchange: (e) => actions.pickLedgerMonth(e.target.value) },
        [...months.map((m) => ({ value: m, label: monthLabel(m + "-01") })), { value: "", label: "Kõik kuud" }],
        month),
      h("button", { class: "btng", type: "button", onclick: () => actions.exportLedger(month) }, "Ekspordi CSV")
    ),

    h("div", { class: "grid4" },
      kpi("Tulu: sularaha + kaart", eur(totals.cashIn + totals.cardIn)),
      kpi("Tulu: ülekandega", eur(totals.bankIn)),
      kpi("Kulud", (totals.out > 0 ? "−" : "") + eur(totals.out), { cls: totals.out > 0 ? "neg" : "" }),
      kpi(month ? "Jääk kuu lõpus" : "Jääk", eur(totals.balance), { inverse: true })
    ),

    panel({},
      h("p", { class: "thr", text: "Lisa kanne", style: "margin:0 0 12px" }),
      h("div", { class: "formrow" },
        field("Kuupäev", inp({ type: "date", value: form.date, oninput: (e) => (form.date = e.target.value) })),
        field("Tüüp", select({ oninput: (e) => (form.kind = e.target.value) },
          [{ value: "tulu", label: "Tulu" }, { value: "kulu", label: "Kulu" }], form.kind)),
        field("Kategooria", select({
          oninput: (e) => {
            form.category = e.target.value;
            customField.hidden = form.category !== "Muu";
            if (customField.hidden) form.custom = "";
          },
        }, options, form.category)),
        customField,
        field("Kirjeldus", inp({ type: "text", placeholder: "Nt. salongi üür",
          oninput: (e) => (form.description = e.target.value) })),
        field("Sularaha", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.cash = e.target.value) })),
        field("Kaart", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.card = e.target.value) })),
        field("Ülekanne", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.bank = e.target.value) })),
        h("button", { class: "btnp", type: "button", onclick: () => actions.addLedger(form) }, "+ Lisa")
      )
    ),

    table(grid,
      ["Kuupäev", "Tüüp", "Kategooria", "Kirjeldus",
       { label: "Sularaha", r: true }, { label: "Kaart", r: true }, { label: "Ülekanne", r: true },
       { label: "Summa", r: true }, { label: "Jääk", r: true }, ""],
      body, month ? "Sel kuul pole kandeid." : "Kandeid veel pole."),
  ];
}

// ------------------------------------------------------------------- ladu

export function viewStock(actions) {
  const form = { date: todayISO(), productId: S.products[0] ? S.products[0].id : null,
                 type: "in", qty: "1", price: "" };
  // A delivery is booked at what it cost; the product's ostuhind is the
  // obvious starting figure, so it is filled in rather than left at zero.
  const costOf = (id) => {
    const p = S.products.find((x) => x.id === id);
    return p && Number(p.cost) ? String(Number(p.cost)) : "";
  };
  form.price = costOf(form.productId);
  const priceInput = inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00", value: form.price,
    oninput: (e) => (form.price = e.target.value) });

  const stockRows = S.products.map((p) => {
    const st = stockStatus(p);
    return h("div", { class: "row", style: "grid-template-columns:1fr 70px 100px 110px" },
      h("span", { class: "tr namecell" },
        p.image_url ? h("img", { class: "thumb", src: p.image_url, alt: "", loading: "lazy" }) : null,
        h("span", { text: p.name })
      ),
      inp({ class: "inp stockinp " + (st.cls === "pos" ? "" : st.cls),
            type: "number", min: "0", step: "1", value: String(Number(p.stock)),
            "aria-label": "Jääk: " + p.name,
            onchange: (e) => actions.setStock(p, parseNum(e.target.value)) }),
      h("span", { class: "tr mono r", text: num(Number(p.stock) * Number(p.cost)) }),
      h("span", { class: "pill r " + st.cls, text: st.label })
    );
  });

  const moveRows = S.movements.map((m) =>
    h("div", { class: "row", style: "grid-template-columns:70px 1fr 70px 70px 90px 30px" },
      h("span", { class: "tr mono", text: dayMonth(m.move_date) }),
      h("span", { class: "tr", text: m.product_name }),
      h("span", { class: "pill " + (m.move_type === "in" ? "pos" : "neg"),
                  text: m.move_type === "in" ? "Sisse" : "Välja" }),
      h("span", { class: "tr mono r", text: String(Number(m.qty)) }),
      h("span", { class: "tr mono r", text: num(m.price) }),
      m.invoice_id
        ? h("span", { class: "thr r", title: "Tuli müügist", text: "·" })
        : h("button", { class: "del", type: "button", title: "Kustuta liikumine",
                        onclick: () => actions.deleteMovement(m) }, "×")
    )
  );

  return [
    head(S.movements.length + " liikumist", "Ladu"),

    h("div", { class: "grid2" },
      kpi("Lao väärtus (ostuhinnas)", eur(stockValue())),
      kpi("Tellida juurde", lowStock().length + " artiklit", { cls: "warnc" })
    ),

    panel({},
      h("p", { class: "thr", text: "Lisa liikumine", style: "margin:0 0 12px" }),
      h("div", { class: "formrow" },
        field("Kuupäev", inp({ type: "date", value: form.date, oninput: (e) => (form.date = e.target.value) })),
        field("Toode", select({ oninput: (e) => {
            form.productId = Number(e.target.value);
            if (form.type === "in") priceInput.value = form.price = costOf(form.productId);
          } },
          S.products.map((p) => ({ value: p.id, label: p.name })), form.productId)),
        field("Liikumine", select({ oninput: (e) => (form.type = e.target.value) },
          [{ value: "in", label: "Sisse (ost)" }, { value: "out", label: "Välja (mahakandmine)" }], form.type)),
        field("Kogus", inp({ type: "number", min: "1", step: "1", value: form.qty,
          oninput: (e) => (form.qty = e.target.value) })),
        field("Ühiku hind", priceInput),
        h("button", { class: "btnp", type: "button", disabled: !S.products.length,
          onclick: () => actions.addMovement(form) }, "+ Lisa")
      )
    ),

    h("div", { class: "cols c2e" },
      h("div", {},
        h("p", { class: "thr", text: "Jääk tootepõhiselt", style: "margin:0 0 10px" }),
        table("1fr 70px 100px 110px",
          ["Toode", { label: "Jääk · muudetav", r: true }, { label: "Väärtus", r: true },
           { label: "Staatus", r: true }],
          stockRows, "Tooteid pole.")
      ),
      h("div", {},
        h("p", { class: "thr", text: "Liikumised", style: "margin:0 0 10px" }),
        table("70px 1fr 70px 70px 90px 30px",
          ["Kuupäev", "Toode", "Liik", { label: "Kogus", r: true }, { label: "Hind", r: true }, ""],
          moveRows, "Liikumisi veel pole.")
      )
    ),
  ];
}

// -------------------------------------------------------------- hinnakiri

export function viewPrices(actions) {
  const st = S.settings || {};

  // Name and note are edited in place like the price: change the field, leave
  // it, and it is saved. An emptied name is put back rather than sent.
  const textCell = (value, label, onSave, attrs = {}) =>
    inp({ type: "text", value, "aria-label": label, ...attrs,
          onchange: (e) => {
            const v = e.target.value.trim();
            if (!v && attrs.required) { e.target.value = value; return; }
            if (v !== value) onSave(v);
          } });

  const serviceRows = S.services.map((s) =>
    h("div", { class: "row", style: "grid-template-columns:minmax(0,1.4fr) 100px minmax(0,1fr) 28px" },
      textCell(s.name, "Teenus", (name) => actions.saveService(s, { name }), { required: true, maxlength: "200" }),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(s.price)),
            "aria-label": "Hind: " + s.name,
            onchange: (e) => actions.saveService(s, { price: parseNum(e.target.value) }) }),
      textCell(s.note || "", "Märkus: " + s.name, (v) => actions.saveService(s, { note: v }),
        { placeholder: "Märkus", maxlength: "200" }),
      h("button", { class: "del", type: "button", title: "Eemalda teenus",
                    onclick: () => actions.removeService(s) }, "×")
    )
  );

  const svcForm = { name: "", price: "", note: "" };
  const addServiceRow = h("div", { class: "formrow", style: "margin-top:10px" },
    field("Uus teenus", inp({ type: "text", maxlength: "200", placeholder: "Nt. Laste lõikus",
      oninput: (e) => (svcForm.name = e.target.value) })),
    field("Hind", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
      oninput: (e) => (svcForm.price = e.target.value) })),
    field("Märkus", inp({ type: "text", maxlength: "200", placeholder: "Nt. 30 min",
      oninput: (e) => (svcForm.note = e.target.value) })),
    h("button", { class: "btnp", type: "button", onclick: () => actions.createService(svcForm) }, "+ Lisa")
  );

  const productRows = S.products.map((p) =>
    h("div", { class: "row", style: "grid-template-columns:minmax(0,1fr) 96px 96px 28px" },
      h("span", { class: "tr namecell" },
        p.image_url ? h("img", { class: "thumb", src: p.image_url, alt: "", loading: "lazy" }) : null,
        textCell(p.name, "Toode", (name) => actions.saveProduct(p, { name }), { required: true, maxlength: "200" })
      ),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(p.cost)),
            "aria-label": "Ostuhind: " + p.name,
            onchange: (e) => actions.saveProduct(p, { cost: parseNum(e.target.value) }) }),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(p.price)),
            "aria-label": "Müügihind: " + p.name,
            onchange: (e) => actions.saveProduct(p, { price: parseNum(e.target.value) }) }),
      h("button", { class: "del", type: "button", title: "Eemalda toode",
                    onclick: () => actions.removeProduct(p) }, "×")
    )
  );

  const prodForm = { name: "", cost: "", price: "", image_url: "" };
  const addProductRow = h("div", { class: "formrow", style: "margin-top:10px" },
    field("Uus toode", inp({ type: "text", maxlength: "200", placeholder: "Nt. Uppercut Deluxe Pomade",
      oninput: (e) => (prodForm.name = e.target.value) })),
    field("Ostuhind", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
      oninput: (e) => (prodForm.cost = e.target.value) })),
    field("Müügihind", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
      oninput: (e) => (prodForm.price = e.target.value) })),
    h("button", { class: "btnp", type: "button", onclick: () => actions.createProduct(prodForm) }, "+ Lisa")
  );

  const setting = (label, key, attrs = {}) =>
    field(label, inp({
      value: st[key] == null ? "" : String(st[key]), ...attrs,
      onchange: (e) => actions.saveSettings({
        [key]: attrs.type === "number" ? parseNum(e.target.value) : e.target.value,
      }),
    }));

  // Whose prices are being edited. The owner picks from all of them; anyone
  // else sees only the barber their account is linked to, which is what makes
  // "my own prices" work without handing out a picker.
  const own = myBarber();
  const picked = isOwner()
    ? (barberById(S.selectedBarberId) || S.barbers[0] || null)
    : own;

  const barberRows = picked
    ? S.services.map((s) => {
        const bp = barberPrice(picked, s);
        return h("div", { class: "row", style: "grid-template-columns:1fr 90px 70px 110px" },
          h("span", { class: "tr" + (bp.offered ? "" : " dim struck"), text: s.name }),
          h("span", { class: "tr mono r dim", text: num(s.price) }),
          h("label", { class: "permbox", title: "Kas " + picked.name + " seda teeb" },
            h("input", {
              type: "checkbox", checked: bp.offered,
              "aria-label": "Pakub: " + s.name,
              onchange: (e) => actions.setBarberPrice(picked, s, bp.price, e.target.checked),
            })
          ),
          inp({
            type: "number", min: "0", step: "0.01", value: String(bp.price),
            disabled: !bp.offered,
            "aria-label": picked.name + " hind: " + s.name,
            onchange: (e) => actions.setBarberPrice(picked, s, parseNum(e.target.value), true),
          })
        );
      })
    : [];

  const barberForm = { name: "", tier: "", phone: "" };
  const barberAdmin = isOwner()
    ? panel({},
        h("p", { class: "thr", text: "Barberid", style: "margin:0 0 12px" }),
        picked
          ? h("div", { class: "formrow" },
              field("Nimi", textCell(picked.name, "Barberi nimi", (name) => actions.saveBarber(picked, { name }),
                { required: true, maxlength: "120" })),
              field("Tase", textCell(picked.tier || "", "Tase", (tier) => actions.saveBarber(picked, { tier }),
                { placeholder: "Nt. Meister", maxlength: "60" })),
              field("Telefon", textCell(picked.phone || "", "Telefon", (phone) => actions.saveBarber(picked, { phone }),
                { maxlength: "40" }))
            )
          : null,
        picked
          ? h("button", { class: "btng sm", type: "button", style: "margin-top:10px",
                          onclick: () => actions.removeBarber(picked) }, "Eemalda " + picked.name)
          : null,
        h("p", { class: "thr", text: "Uus barber", style: "margin:16px 0 8px" }),
        h("div", { class: "formrow" },
          field("Nimi", inp({ type: "text", maxlength: "120", placeholder: "Nt. Barber Mari",
            oninput: (e) => (barberForm.name = e.target.value) })),
          field("Tase", inp({ type: "text", maxlength: "60", placeholder: "Nt. Rookie",
            oninput: (e) => (barberForm.tier = e.target.value) })),
          field("Telefon", inp({ type: "text", maxlength: "40",
            oninput: (e) => (barberForm.phone = e.target.value) })),
          h("button", { class: "btnp", type: "button", onclick: () => actions.createBarber(barberForm) }, "+ Lisa")
        ),
        note("Konto sidumine barberiga käib Kontode all. Seotud konto näeb kassas ainult enda nime ja hindu.",
          "margin:12px 0 0")
      )
    : null;

  const barberBlock = !picked
    ? null
    : h("div", {},
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 10px;flex-wrap:wrap" },
          h("p", { class: "thr", text: "Barberi hinnad", style: "margin:0" }),
          // The picker is the owner's. A barber reaching this screen sees the
          // one name their account is attached to and nobody else's.
          isOwner()
            ? select(
                { style: "width:auto;min-width:190px", "aria-label": "Barber",
                  onchange: (e) => actions.pickBarber(Number(e.target.value)) },
                S.barbers.map((b) => ({ value: b.id, label: b.name + (b.tier ? " · " + b.tier : "") })),
                picked.id
              )
            : h("span", { class: "pill pos", text: picked.name })
        ),
        table("1fr 90px 70px 110px",
          ["Teenus", { label: "Tavahind", r: true }, { label: "Pakub", r: true }, { label: "Hind", r: true }],
          barberRows, "Teenuseid pole."),
        note("Need hinnad ilmuvad kassas, kui see barber on valitud. Märkeruudu eemaldamine " +
          "kriipsutab teenuse tema all läbi ja seda ei saa talle arvele lisada. " +
          "Salongi enda tavahind ülal jääb puutumata.", "margin:10px 0 0")
      );

  return [
    head("Teenused, tooted ja käibemaks", "Hinnakiri"),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        h("div", {},
          h("p", { class: "thr", text: "Teenused", style: "margin:0 0 10px" }),
          table("minmax(0,1.4fr) 100px minmax(0,1fr) 28px",
            ["Teenus", { label: "Hind", r: true }, "Märkus", ""], serviceRows, "Teenuseid pole."),
          addServiceRow
        ),
        barberBlock,

        h("div", {},
          h("p", { class: "thr", text: "Tooted", style: "margin:0 0 10px" }),
          table("minmax(0,1fr) 96px 96px 28px",
            ["Toode", { label: "Ostuhind", r: true }, { label: "Müügihind", r: true }, ""],
            productRows, "Tooteid pole."),
          addProductRow
        )
      ),

      h("div", { class: "stack" },
        barberAdmin,
        panel({},
          h("p", { class: "thr", text: "Arve seaded", style: "margin:0 0 12px" }),
          h("label", { class: "check", style: "margin-bottom:12px" },
            h("input", { type: "checkbox", checked: st.show_vat !== false,
              onchange: (e) => actions.saveSettings({ show_vat: e.target.checked }) }),
            "Näita käibemaksu ridu"
          ),
          h("div", { class: "formrow" },
            setting("KM määr %", "vat_rate", { type: "number", min: "0", max: "100", step: "1" }),
            setting("Madala jäägi piir", "low_stock", { type: "number", min: "0", step: "1" }),
            setting("Maksetähtaeg (päeva)", "payment_days", { type: "number", min: "0", max: "365", step: "1" })
          ),
          h("label", { class: "check", style: "margin-top:14px" },
            h("input", { type: "checkbox", checked: st.ask_tip !== false,
              onchange: (e) => actions.saveSettings({ ask_tip: e.target.checked }) }),
            "Küsi jootraha kiirmüügis"
          ),
          note("Hinnad sisaldavad käibemaksu. Jootraha on käibemaksuvaba ja seda ei arvestata teenuse käibe hulka.",
            "margin:12px 0 0")
        ),

        panel({},
          h("p", { class: "thr", text: "Arve päis ja kassa", style: "margin:0 0 12px" }),
          h("div", { class: "formrow" },
            setting("Ettevõte", "company_name"),
            setting("Aadress", "company_address"),
            setting("Reg. number", "company_reg"),
            setting("KMKR number", "company_kmkr"),
            setting("Pank", "company_bank"),
            setting("IBAN", "company_iban", { placeholder: "EE00 0000 0000 0000 0000" }),
            setting("Telefon", "company_phone"),
            setting("E-post", "company_email"),
            setting("Koduleht", "company_web"),
            setting("Kassa algsaldo", "opening_balance", { type: "number", step: "0.01" })
          ),
          note("Need väljad ilmuvad iga arve päisesse. IBAN on vajalik maksmata arvetel. " +
            "Algsaldo on kassas olnud sularaha enne esimest kannet.", "margin:12px 0 0")
        )
      )
    ),
  ];
}

// --------------------------------------------------------------- kliendid

// A regular and the prices agreed with them. Those prices are a default the
// till fills in, never a rule: the invoice line still stores its own copy, so
// changing a price here cannot rewrite an invoice already issued.
export function viewCustomers(actions) {
  const selected = S.customers.find((c) => c.id === S.selectedCustomerId) || S.customers[0] || null;
  const form = { name: "", details: "", note: "" };

  const rows = S.customers.map((c) =>
    h("div", {
      class: "row click" + (selected && c.id === selected.id ? " sel" : ""),
      style: "grid-template-columns:1fr auto",
      onclick: () => actions.openCustomer(c.id),
    },
      h("div", {},
        h("div", { class: "tr", text: c.name }),
        c.details ? h("div", { class: "thr", style: "margin-top:3px", text: c.details }) : null
      ),
      h("span", { class: "tr mono r dim",
                  text: Object.keys(c.prices || {}).length
                    ? Object.keys(c.prices).length + " erihinda"
                    : "—" })
    )
  );

  const priceRows = selected
    ? S.services.map((s) => {
        const agreed = (selected.prices || {})[s.id];
        return h("div", { class: "row", style: "grid-template-columns:1fr 90px 110px" },
          h("span", { class: "tr", text: s.name }),
          h("span", { class: "tr mono r dim", text: num(s.price) }),
          // Whoever may open Kliendid may set these — the server's rule. The
          // old screen offered the field to the owner only, while the server
          // took it from anyone with the switch on.
          inp({
            type: "number", min: "0", step: "0.01",
            value: agreed === undefined ? "" : String(agreed),
            placeholder: "tavahind",
            "aria-label": "Erihind: " + s.name,
            onchange: (e) => actions.setCustomerPrice(selected.id, s.id, e.target.value),
          })
        );
      })
    : [];

  return [
    head(S.customers.length + " klienti", "Kliendid",
      h("button", { class: "btnp", type: "button", onclick: () => actions.goto("pos") }, "+ Uus müük")
    ),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        table("1fr auto", ["Klient", { label: "Hinnad", r: true }], rows, "Kliente pole veel."),
        panel({},
          h("p", { class: "thr", text: "Uus klient", style: "margin:0 0 12px" }),
          h("div", { style: "display:flex;flex-direction:column;gap:10px" },
            field("Nimi või ettevõte", inp({
              type: "text", maxlength: "200", autocomplete: "off",
              oninput: (e) => (form.name = e.target.value),
            })),
            field("Registrikood, aadress või e-post", inp({
              type: "text", maxlength: "500", autocomplete: "off",
              placeholder: "Nt. 12345678 · Riia 12, Tartu",
              oninput: (e) => (form.details = e.target.value),
            })),
            field("Märkus", inp({
              type: "text", maxlength: "300", autocomplete: "off",
              placeholder: "Nt. arved kuu lõpus koondarvena",
              oninput: (e) => (form.note = e.target.value),
            }))
          ),
          h("button", { class: "btnp wide", type: "button", style: "margin-top:12px",
                        onclick: () => actions.addCustomer(form) }, "Lisa klient")
        )
      ),

      selected
        ? h("div", { class: "stack" },
            panel({},
              h("p", { class: "thr", text: "Kokkulepitud hinnad", style: "margin:0 0 4px" }),
              h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:0 0 12px;line-height:1.5" },
                "Need hinnad täidetakse arvele automaatselt, kui valid kassas selle kliendi. " +
                "Rea hinda saab arvel ikka üle kirjutada ja see ei muuda hinnakirja."),
              table("1fr 90px 110px",
                ["Teenus", { label: "Tavahind", r: true }, { label: "Erihind", r: true }],
                priceRows, "Teenuseid pole.")
            ),
            panel({},
              h("p", { class: "thr", text: "Kliendi andmed", style: "margin:0 0 12px" }),
              h("div", { style: "display:flex;flex-direction:column;gap:10px" },
                ...[
                  ["name", "Nimi või ettevõte", 200],
                  ["details", "Registrikood, aadress või e-post", 500],
                  ["note", "Märkus", 300],
                ].map(([key, label, max]) =>
                  field(label, inp({
                    type: "text", maxlength: String(max), autocomplete: "off", value: selected[key] || "",
                    onchange: (e) => {
                      const v = e.target.value.trim();
                      if (key === "name" && !v) { e.target.value = selected.name; return; }
                      if (v !== (selected[key] || "")) actions.updateCustomer(selected, { [key]: v });
                    },
                  }))
                )
              ),
              h("button", { class: "btng wide", type: "button", style: "margin-top:12px",
                            onclick: () => actions.removeCustomer(selected) }, "Eemalda klient")
            )
          )
        : h("p", { class: "empty", text: "Vali klient või lisa uus." })
    ),
  ];
}

// ----------------------------------------------------------------- kontod

// Staff accounts and the trail of what was done to the books. Owner-only: the
// nav tab is hidden for a barber and every route behind it checks again.
export function viewAdmin(actions) {
  const form = { name: "", email: "", password: "", role: "barber" };

  const grid = "1fr 1.2fr 100px 118px 108px 150px";

  const staffRows = S.staff.map((u) =>
    h("div", { class: "row", style: "grid-template-columns:" + grid },
      h("span", { class: "tr", text: u.name || "—" }),
      h("span", { class: "tr dim", text: u.email }),
      u.role === "omanik" || u.id === (S.me && S.me.id)
        ? h("span", { class: "pill pos", text: u.role })
        : select({ "aria-label": "Roll: " + u.email, onchange: (e) => actions.setStaffRole(u, e.target.value) },
                  [{ value: "barber", label: "barber" }, { value: "omanik", label: "omanik" }],
                  u.role),
      // Deleting is for barbers. An owner is demoted first, which keeps one
      // click from removing someone who can manage everyone else.
      u.id === (S.me && S.me.id)
        ? h("span", { class: "thr", text: "sina" })
        : u.role === "omanik"
          ? h("span", { class: "thr", title: "Kustutamiseks muuda roll enne barberiks", text: "—" })
          : h("div", { style: "display:flex;flex-direction:column;gap:4px" },
              // Accounts closed before deleting existed can still be let back in.
              u.active
                ? null
                : h("button", { class: "btng sm", type: "button",
                                onclick: () => actions.reopenStaff(u) }, "Taasava"),
              h("button", { class: "btng sm", type: "button",
                            onclick: () => actions.deleteStaff(u) }, "Kustuta konto")),
      // The forgotten-password case. The owner sets a new one; the old is
      // replaced, never revealed.
      u.id === (S.me && S.me.id)
        ? h("span", { class: "thr", text: "vt all" })
        : h("button", { class: "btng sm", type: "button",
                        onclick: () => actions.resetStaffPassword(u) }, "Uus parool"),

      // Which chair this login belongs to. Setting it is what makes the
      // account see its own prices under Hinnakiri, and what stops it ringing
      // a sale up under another barber's name — the till picker then holds
      // only this one.
      u.role === "omanik"
        ? h("span", { class: "thr r", title: "Omanik pääseb kõigi juurde", text: "—" })
        : select(
            { "aria-label": "Barber: " + u.email,
              onchange: (e) => actions.linkBarber(u, e.target.value ? Number(e.target.value) : null) },
            [{ value: "", label: "— sidumata —" },
             ...S.barbers.map((b) => ({ value: b.id, label: b.name }))],
            (S.barbers.find((b) => b.account_id === u.id) || {}).id || ""
          )
    )
  );

  const pw = { current: "", next: "", again: "" };

  // One row per account, one switch per area. The owner's own row shows no
  // switches: an owner always has everything, and offering a checkbox that the
  // server refuses would be a lie on screen.
  const permGrid = "1.3fr repeat(" + AREAS.length + ", minmax(72px, 1fr))";

  const permRows = S.staff.map((u) => {
    const perms = permsOf(u);
    return h("div", { class: "row", style: "grid-template-columns:" + permGrid },
      h("span", { class: "tr" },
        h("span", { text: u.name || u.email }),
        u.active ? null : h("span", { class: "pill neg", style: "margin-left:8px", text: "suletud" })
      ),
      ...AREAS.map((area) =>
        u.role === "omanik"
          ? h("span", { class: "thr r", title: "Omanikul on alati kõik õigused", text: "kõik" })
          : h("label", { class: "permbox", title: AREA_LABEL[area] + " — " + (u.name || u.email) },
              h("input", {
                type: "checkbox", checked: perms[area],
                "aria-label": AREA_LABEL[area] + ": " + (u.name || u.email),
                onchange: (e) => actions.setStaffPermission(u, area, e.target.checked),
              })
            )
      )
    );
  });

  const auditRows = S.audit.map((a) =>
    h("div", { class: "row", style: "grid-template-columns:128px 1fr 1fr" },
      h("span", { class: "tr mono", text: dateTimeET(a.created_at) }),
      h("span", { class: "tr", text: a.action + (a.invoice_nr ? " · " + a.invoice_nr : "") }),
      h("span", { class: "tr dim", text: (a.actor_name || a.actor_email || "—") +
                                         (a.detail ? " · " + a.detail : "") })
    )
  );

  return [
    head(S.staff.length + " kontot", "Kontod"),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        h("div", {},
          h("p", { class: "thr", text: "Töötajad", style: "margin:0 0 10px" }),
          table(grid, ["Nimi", "E-post", "Roll", "Konto", "Parool", "Barber"],
            staffRows, "Kontosid pole.")
        ),

        h("div", {},
          h("p", { class: "thr", text: "Mida keegi näeb", style: "margin:0 0 10px" }),
          table(permGrid, ["Konto", ...AREAS.map((a) => AREA_LABEL[a])],
            permRows, "Kontosid pole."),
          h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:10px 0 0;line-height:1.5" },
            "Lüliti peidab vahekaardi ja keelab ka serveris — lingi käsitsi tippimine ei aita. " +
            "Töölaud, Kiirmüük ja Arved jäävad kõigile: see on töö ise. " +
            "Arvete kustutamine (tühistamine ja jäädav kustutamine) on barberitel vaikimisi sees. " +
            "Arve makstuks märkimine ning kontode haldus jäävad alati ainult omanikule, " +
            "ka siis kui Kontod on kellelegi lubatud.")
        ),

        panel({},
          h("p", { class: "thr", text: "Minu parool", style: "margin:0 0 12px" }),
          h("div", { style: "display:flex;flex-direction:column;gap:10px" },
            field("Praegune parool", inp({
              type: "password", autocomplete: "current-password",
              oninput: (e) => (pw.current = e.target.value) })),
            field("Uus parool (vähemalt 8 tähemärki)", inp({
              type: "password", autocomplete: "new-password",
              oninput: (e) => (pw.next = e.target.value) })),
            field("Uus parool uuesti", inp({
              type: "password", autocomplete: "new-password",
              oninput: (e) => (pw.again = e.target.value) }))
          ),
          h("button", { class: "btnp wide", type: "button", style: "margin-top:12px",
                        onclick: () => actions.changeMyPassword(pw) }, "Vaheta parool")
        ),
        panel({},
          h("p", { class: "thr", text: "Uus konto", style: "margin:0 0 12px" }),
          h("div", { style: "display:flex;flex-direction:column;gap:10px" },
            field("Nimi", inp({ type: "text", maxlength: "120", autocomplete: "off",
              oninput: (e) => (form.name = e.target.value) })),
            field("E-post", inp({ type: "email", autocomplete: "off",
              oninput: (e) => (form.email = e.target.value) })),
            field("Ajutine parool (vähemalt 8 tähemärki)", inp({
              type: "password", autocomplete: "new-password",
              oninput: (e) => (form.password = e.target.value) })),
            field("Roll", select({ onchange: (e) => (form.role = e.target.value) },
              [{ value: "barber", label: "Barber — kassa ja arved, muu lülititega" },
               { value: "omanik", label: "Omanik — kõik õigused" }], form.role))
          ),
          h("button", { class: "btnp wide", type: "button", style: "margin-top:12px",
                        onclick: () => actions.addStaff(form) }, "Loo konto"),
          h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
            "Anna parool töötajale edasi ja lase tal see ise ära vahetada. " +
            "Konto kustutamine eemaldab sisselogimise jäädavalt ja tema nime tegevuste logist. " +
            "Arvetel jääb tema nimi alles.")
        )
      ),

      h("div", { class: "stack" },
        h("div", {},
          h("p", { class: "thr", text: "Mida on tehtud", style: "margin:0 0 10px" }),
          table("128px 1fr 1fr", ["Millal", "Toiming", "Kes"],
            auditRows, "Veel pole midagi kirjas.")
        ),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:0;line-height:1.5" },
          "Siia jääb jälg igast tühistamisest, esitamisest, maksmisest, kontomuudatusest, " +
          "inventuurist ning käsitsi kande või laoliikumise kustutamisest. " +
          "See on ainus koht, kust hiljem näed, kes mida tegi.")
      )
    ),
  ];
}

// ---------------------------------------------------------- kuu kokkuvõte

// What each barber brought in over one month, which is the figure a payout is
// worked out from. Built entirely from invoice lines already loaded, so the
// month can be changed without another round trip.
export function viewMonth(actions) {
  const months = invoiceMonths();
  const month = months.includes(S.reportMonth) ? S.reportMonth : months[0];
  const rows = monthlyByBarber(month);
  const total = Math.round(rows.reduce((s, r) => s + r.gross, 0) * 100) / 100;
  const qty = rows.reduce((s, r) => s + r.qty, 0);

  const grid = "1.4fr 80px 80px 110px 70px";

  const body = rows.map((r) =>
    h("div", { class: "row", style: "grid-template-columns:" + grid },
      h("div", {},
        h("div", { class: "tr", text: r.barber }),
        h("div", { class: "thr", style: "margin-top:3px",
                   text: r.services.map((s) => s.name + " ×" + s.qty).join(" · ").slice(0, 80) })
      ),
      h("span", { class: "tr mono r dim", text: String(r.lines) }),
      h("span", { class: "tr mono r", text: String(Math.round(r.qty * 100) / 100) }),
      h("span", { class: "tr mono r", text: eur(r.gross) }),
      h("span", { class: "tr mono r dim",
                  text: total > 0 ? Math.round((r.gross / total) * 100) + "%" : "–" })
    )
  );

  return [
    head(monthLabel(month + "-01"), "Kuu kokkuvõte",
      select({ style: "width:auto;min-width:150px",
               onchange: (e) => actions.pickReportMonth(e.target.value) },
        months.map((m) => ({ value: m, label: monthLabel(m + "-01") })), month),
      h("button", { class: "btng", type: "button",
                    onclick: () => actions.exportMonth(month) }, "Ekspordi CSV")
    ),

    h("div", { class: "grid4" },
      kpi("Käive kokku", eur(total)),
      kpi("Teenuseid", String(Math.round(qty * 100) / 100)),
      kpi("Barbereid", String(rows.length)),
      kpi("Keskmine barberi kohta", eur(rows.length ? total / rows.length : 0), { inverse: true })
    ),

    table(grid,
      ["Barber", { label: "Ridu", r: true }, { label: "Kogus", r: true },
       { label: "Käive", r: true }, { label: "Osa", r: true }],
      body, "Sel kuul pole ühtegi arvet."),

    h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
      "Arvestatud on esitatud ja makstud arved; mustandid ja tühistatud arved jäävad välja. " +
      "Rida jõuab barberi alla selle järgi, kes oli kassas valitud. " +
      "„Määramata\" on read, mis tehti enne barberi valiku kasutuselevõttu."),
  ];
}

export const VIEWS = {
  dash: viewDash,
  pos: viewPos,
  inv: viewInvoices,
  cash: viewLedger,
  stock: viewStock,
  price: viewPrices,
  cust: viewCustomers,
  admin: viewAdmin,
  month: viewMonth,
};
