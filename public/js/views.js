// views.js — every screen, as functions that return DOM nodes.
// Views read from state.js and call back into the `actions` object that
// main.js passes in; they never talk to the server themselves.

import { h, panel, eur, num, signed, dateET, dayMonth, todayISO, monthLabel, parseNum } from "./util.js";

// Mirrors the list the server offers; either side may be extended freely.
const LEDGER_CATEGORIES = ["Teenuste müük", "Kaubamüük", "Kaubavaru", "Rent", "Töövahendid", "Palk"];
import {
  S, draftVat, paymentMismatch, draftTotal, METHOD_LABEL, UNITS,
  ledgerWithBalance, ledgerTotals, dayFigures, stockValue, lowStock, stockStatus, isCancelled,
  lineTotal, isDraft, isUnpaid, statusLabel, unpaidInvoices, unpaidTotal,
  isOwner, pastBuyers, customerById,
} from "./state.js";

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

// Whether this invoice holds the last number of its month. Only such an
// invoice can be removed outright — the counter winds back and the sequence
// closes up. The server checks this again; here it decides whether the button
// is worth offering at all.
const seqOf = (nr) => Number(String(nr).split("-")[1]) || 0;

function isLastOfMonth(invoice) {
  if (!invoice.nr) return false;
  const prefix = String(invoice.nr).split("-")[0];
  const mine = seqOf(invoice.nr);
  return !S.invoices.some(
    (i) => i.id !== invoice.id && i.nr && String(i.nr).startsWith(prefix + "-") && seqOf(i.nr) > mine
  );
}

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
  const askTip = !(S.settings && S.settings.ask_tip === false);
  const showVat = !(S.settings && S.settings.show_vat === false);

  const serviceCards = S.services.map((s) =>
    h("button", {
      class: "svc", type: "button",
      // serviceId travels with the line so a report can count haircuts later
      // and a customer's agreed price knows which service it applies to. The
      // name and price are still copied onto the invoice, never referenced.
      onclick: () => actions.addLine({ serviceId: s.id, name: s.name, price: Number(s.price) }),
    },
      h("span", { class: "svcn", text: s.name }),
      h("span", { class: "svcp", text: eur(s.price) }),
      s.note ? h("span", { class: "svcm", text: s.note }) : null
    )
  );

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
      h("span", { class: "svcm" + (out ? " neg" : Number(p.stock) <= 3 ? " warnc" : ""),
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

    return h("div", { class: "dline" + (l.open ? " open" : "") },
      // Carries .tr as well as .dname: the barber add-on reads a line's name
      // out of the DOM with querySelector(".tr"), and it is a separate,
      // deliberately self-contained file that should not have to know this
      // row was rebuilt.
      h("button", {
        class: "dname tr", type: "button", title: "Ava rida",
        onclick: () => actions.toggleLine(l.key),
      }, l.name),
      inp({ type: "number", min: "0", step: "1", value: String(l.qty),
            "aria-label": "Kogus", oninput: (e) => actions.updateLine(l.key, { qty: parseNum(e.target.value) }) }),
      inp({ type: "number", min: "0", step: "0.01", value: String(l.price),
            "aria-label": "Hind", oninput: (e) => actions.updateLine(l.key, { price: parseNum(e.target.value) }) }),
      // .dexp, not .del: throughout this app .del means "remove this thing",
      // and the barber add-on clicks the first .del in a line to drop it. An
      // expander wearing that class would open the row instead of removing it.
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
      S.draft.editingId ? "Mustandi muutmine" : "Uus arve · " + expectedNr(),
      S.draft.editingId ? "Koondarve" : "Kiirmüük",
      h("button", { class: "btng", type: "button", onclick: actions.clearDraft },
        S.draft.editingId ? "Loobu muutmisest" : "Tühjenda")
    ),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        panel({},
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
          S.draft.lines.length && mismatch !== 0
            ? "Vahe " + num(Math.abs(mismatch) / 100) + " € — sularaha ja kaart kokku peavad võrduma summaga."
            : ""),

        // Two ways out of the till. Saving a draft mints no number and books
        // nothing, so a consolidated invoice can be built up over a week and
        // thrown away without leaving a hole in the sequence.
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" },
          h("button", {
            id: "posDraft", class: "btng", type: "button", style: "flex:1 1 150px",
            disabled: !S.draft.lines.length,
            onclick: actions.saveDraft,
          }, S.draft.editingId ? "Salvesta mustand" : "Salvesta mustandina"),
          h("button", {
            id: "posFinish", class: "btnp", type: "button", style: "flex:2 1 180px",
            disabled: !S.draft.lines.length || mismatch !== 0,
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
        disabled: !S.draft.lines.length || mismatch !== 0,
        onclick: actions.finishSale,
      }, "Lõpeta")
    ),
  ];
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

  if (selected && !isDraft(selected) && isOwner()) {
    if (isCancelled(selected)) {
      acts.push(
        h("button", { class: "btng", type: "button",
                      onclick: () => actions.uncancelInvoice(selected) }, "Võta tühistamine tagasi"),
        // Only offered when it can be done without leaving a hole: the invoice
        // is cancelled and holds the last number of its month.
        isLastOfMonth(selected)
          ? h("button", { class: "btng", type: "button",
                          onclick: () => actions.purgeInvoice(selected) }, "Kustuta jäädavalt")
          : null
      );
    } else {
      acts.push(
        h("button", { class: "btng", type: "button",
                      onclick: () => actions.cancelInvoice(selected) }, "Tühista arve")
      );
    }
  }

  acts.push(h("button", { class: "btnp", type: "button", onclick: () => actions.goto("pos") }, "+ Uus müük"));

  return [
    head(S.invoices.length + " arvet", "Arved", ...acts),

    h("div", { class: "cols cinv" },
      h("div", { class: "noprint" },
        owedBanner,
        table("1fr auto", ["Arve", { label: "Summa", r: true }], rows, "Arveid veel pole."),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
          isOwner()
            ? "Arve avaneb kõrval A4 lehena. Trüki / PDF saadab printi ainult lehe, ilma liideseta."
            : "Arve avaneb kõrval A4 lehena. Esitatud arve tühistamine on omaniku õigus.")
      ),
      selected ? invoiceSheet(selected) : h("p", { class: "empty", text: "Vali arve." })
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
          isDraft(invoice)
            ? null
            : h("div", { text: "Viitenumber " + String(invoice.nr).replace(/\D/g, "") })
        )
      )
    ),

    isCancelled(invoice)
      ? h("p", { class: "a4void", text: "Tühistatud " + dateET(invoice.cancelled_at) +
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
      isUnpaid(invoice)
        ? h("div", { text: "Maksmata · palume tasuda ülekandega " + dateET(invoice.due_date) + " arvel toodud arveldusarvele." })
        : h("div", {
            text: [
              Number(invoice.cash) ? "Sularaha " + num(invoice.cash) : null,
              Number(invoice.card) ? "Kaart " + num(invoice.card) : null,
              Number(invoice.bank) ? "Ülekanne " + num(invoice.bank) : null,
            ].filter(Boolean).join(" · ") || "Tasutud",
          }),
      h("div", { text: "Palume tasuda arvel toodud tähtajaks." })
    )
  );
}

// ------------------------------------------------------------ kassaraamat

export function viewLedger(actions) {
  const totals = ledgerTotals();
  const rows = ledgerWithBalance();
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
                        onclick: () => actions.deleteLedger(e.id) }, "×")
    )
  );

  return [
    head(monthLabel(todayISO()), "Kassaraamat",
      h("button", { class: "btng", type: "button", onclick: actions.exportLedger }, "Ekspordi CSV")
    ),

    h("div", { class: "grid4" },
      kpi("Sularaha + kaart", eur(totals.cashIn + totals.cardIn)),
      kpi("Ülekandega", eur(totals.bankIn)),
      kpi("Kulud", (totals.out > 0 ? "−" : "") + eur(totals.out), { cls: totals.out > 0 ? "neg" : "" }),
      kpi("Jääk", eur(totals.balance), { inverse: true })
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
      body, "Kandeid veel pole."),
  ];
}

// ------------------------------------------------------------------- ladu

export function viewStock(actions) {
  const form = { date: todayISO(), productId: S.products[0] ? S.products[0].id : null,
                 type: "in", qty: "1", price: "" };

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
            onchange: (e) => actions.setStock(p.id, p.name, parseNum(e.target.value)) }),
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
                        onclick: () => actions.deleteMovement(m.id) }, "×")
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
        field("Toode", select({ oninput: (e) => (form.productId = Number(e.target.value)) },
          S.products.map((p) => ({ value: p.id, label: p.name })), form.productId)),
        field("Liikumine", select({ oninput: (e) => (form.type = e.target.value) },
          [{ value: "in", label: "Sisse (ost)" }, { value: "out", label: "Välja (mahakandmine)" }], form.type)),
        field("Kogus", inp({ type: "number", min: "1", step: "1", value: form.qty,
          oninput: (e) => (form.qty = e.target.value) })),
        field("Ühiku hind", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.price = e.target.value) })),
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

  const serviceRows = S.services.map((s) =>
    h("div", { class: "row", style: "grid-template-columns:1fr 110px 1fr" },
      h("span", { class: "tr", text: s.name }),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(s.price)),
            "aria-label": "Hind: " + s.name,
            onchange: (e) => actions.saveService(s.id, { price: parseNum(e.target.value) }) }),
      h("span", { class: "thr", text: s.note || "" })
    )
  );

  const productRows = S.products.map((p) =>
    h("div", { class: "row", style: "grid-template-columns:1fr 110px 110px" },
      h("span", { class: "tr namecell" },
        p.image_url ? h("img", { class: "thumb", src: p.image_url, alt: "", loading: "lazy" }) : null,
        h("span", { text: p.name })
      ),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(p.cost)),
            "aria-label": "Ostuhind: " + p.name,
            onchange: (e) => actions.saveProduct(p.id, { cost: parseNum(e.target.value) }) }),
      inp({ type: "number", min: "0", step: "0.01", value: String(Number(p.price)),
            "aria-label": "Müügihind: " + p.name,
            onchange: (e) => actions.saveProduct(p.id, { price: parseNum(e.target.value) }) })
    )
  );

  const setting = (label, key, attrs = {}) =>
    field(label, inp({
      value: st[key] == null ? "" : String(st[key]), ...attrs,
      onchange: (e) => actions.saveSettings({
        [key]: attrs.type === "number" ? parseNum(e.target.value) : e.target.value,
      }),
    }));

  return [
    head("Teenused ja käibemaks", "Hinnakiri"),

    h("div", { class: "cols c2" },
      h("div", { class: "stack" },
        h("div", {},
          h("p", { class: "thr", text: "Teenused", style: "margin:0 0 10px" }),
          table("1fr 110px 1fr", ["Teenus", { label: "Hind", r: true }, "Märkus"],
            serviceRows, "Teenuseid pole.")
        ),
        h("div", {},
          h("p", { class: "thr", text: "Tooted", style: "margin:0 0 10px" }),
          table("1fr 110px 110px",
            ["Toode", { label: "Ostuhind", r: true }, { label: "Müügihind", r: true }],
            productRows, "Tooteid pole.")
        )
      ),

      h("div", { class: "stack" },
        panel({},
          h("p", { class: "thr", text: "Arve seaded", style: "margin:0 0 12px" }),
          h("label", { class: "check", style: "margin-bottom:12px" },
            h("input", { type: "checkbox", checked: st.show_vat !== false,
              onchange: (e) => actions.saveSettings({ show_vat: e.target.checked }) }),
            "Näita käibemaksu ridu"
          ),
          h("div", { class: "formrow" },
            setting("KM määr %", "vat_rate", { type: "number", min: "0", max: "30", step: "1" }),
            setting("Madala jäägi piir", "low_stock", { type: "number", min: "0", step: "1" }),
            setting("Maksetähtaeg (päeva)", "payment_days", { type: "number", min: "0", step: "1" })
          ),
          h("label", { class: "check", style: "margin-top:14px" },
            h("input", { type: "checkbox", checked: st.ask_tip !== false,
              onchange: (e) => actions.saveSettings({ ask_tip: e.target.checked }) }),
            "Küsi jootraha kiirmüügis"
          ),
          h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
            "Hinnad sisaldavad käibemaksu. Jootraha on käibemaksuvaba ja seda ei arvestata teenuse käibe hulka.")
        ),

        panel({},
          h("p", { class: "thr", text: "Arve päis ja kassa", style: "margin:0 0 12px" }),
          h("div", { class: "formrow" },
            setting("Ettevõte", "company_name"),
            setting("Aadress", "company_address"),
            setting("Reg. number", "company_reg"),
            setting("KMKR number", "company_kmkr"),
            setting("Pank", "company_bank"),
            setting("IBAN", "company_iban"),
            setting("Telefon", "company_phone"),
            setting("E-post", "company_email"),
            setting("Koduleht", "company_web"),
            setting("Kassa algsaldo", "opening_balance", { type: "number", step: "0.01" })
          ),
          h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
            "Need väljad ilmuvad iga arve päisesse. Algsaldo on kassas olnud sularaha enne esimest kannet.")
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
          isOwner()
            ? inp({
                type: "number", min: "0", step: "0.01",
                value: agreed === undefined ? "" : String(agreed),
                placeholder: "tavahind",
                "aria-label": "Erihind: " + s.name,
                onchange: (e) => actions.setCustomerPrice(selected.id, s.id, e.target.value),
              })
            : h("span", { class: "tr mono r", text: agreed === undefined ? "—" : num(agreed) })
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
            isOwner()
              ? panel({},
                  h("p", { class: "thr", text: selected.name, style: "margin:0 0 12px" }),
                  h("button", { class: "btng wide", type: "button",
                                onclick: () => actions.removeCustomer(selected) }, "Eemalda klient")
                )
              : null
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

  const grid = "1fr 1.2fr 110px 104px 116px";

  const staffRows = S.staff.map((u) =>
    h("div", { class: "row", style: "grid-template-columns:" + grid },
      h("span", { class: "tr", text: u.name || "—" }),
      h("span", { class: "tr dim", text: u.email }),
      u.role === "omanik" || u.id === (S.me && S.me.id)
        ? h("span", { class: "pill pos", text: u.role })
        : select({ onchange: (e) => actions.setStaffRole(u.id, e.target.value) },
                  [{ value: "barber", label: "barber" }, { value: "omanik", label: "omanik" }],
                  u.role),
      u.id === (S.me && S.me.id)
        ? h("span", { class: "thr", text: "sina" })
        : u.active
          ? h("button", { class: "btng sm", type: "button",
                          onclick: () => actions.closeStaff(u) }, "Sulge konto")
          : h("button", { class: "btng sm", type: "button",
                          onclick: () => actions.reopenStaff(u) }, "Taasava"),
      // The forgotten-password case. The owner sets a new one; the old is
      // replaced, never revealed.
      h("button", { class: "btng sm", type: "button",
                    onclick: () => actions.resetStaffPassword(u) }, "Uus parool")
    )
  );

  const pw = { current: "", next: "", again: "" };

  const auditRows = S.audit.map((a) =>
    h("div", { class: "row", style: "grid-template-columns:120px 1fr 1fr" },
      h("span", { class: "tr mono", text: dateET(a.created_at) }),
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
          table(grid, ["Nimi", "E-post", "Roll", "Konto", "Parool"],
            staffRows, "Kontosid pole.")
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
              [{ value: "barber", label: "Barber — koostab arveid, ei tühista" },
               { value: "omanik", label: "Omanik — kõik õigused" }], form.role))
          ),
          h("button", { class: "btnp wide", type: "button", style: "margin-top:12px",
                        onclick: () => actions.addStaff(form) }, "Loo konto"),
          h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
            "Anna parool töötajale edasi ja lase tal see ise ära vahetada. " +
            "Konto sulgemine ei kustuta midagi — arved jäävad tema nimele alles.")
        )
      ),

      h("div", { class: "stack" },
        h("div", {},
          h("p", { class: "thr", text: "Mida on tehtud", style: "margin:0 0 10px" }),
          table("120px 1fr 1fr", ["Millal", "Toiming", "Kes"],
            auditRows, "Veel pole midagi kirjas.")
        ),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:0;line-height:1.5" },
          "Siia jääb jälg igast tühistamisest, esitamisest, maksmisest ja kontomuudatusest. " +
          "See on ainus koht, kust hiljem näed, kes mida tegi.")
      )
    ),
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
};
