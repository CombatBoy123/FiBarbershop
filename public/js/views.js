// views.js — every screen, as functions that return DOM nodes.
// Views read from state.js and call back into the `actions` object that
// main.js passes in; they never talk to the server themselves.

import { h, panel, eur, num, signed, dateET, dayMonth, todayISO, monthLabel, parseNum } from "./util.js";
import {
  S, draftVat, paymentMismatch, draftTotal, METHOD_LABEL,
  ledgerWithBalance, ledgerTotals, dayFigures, stockValue, lowStock, stockStatus, isCancelled,
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
      kpi("Sularahas", eur(day.cash)),
      kpi("Kaardiga", eur(day.card)),
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
  const askTip = !(S.settings && S.settings.ask_tip === false);
  const showVat = !(S.settings && S.settings.show_vat === false);

  const serviceCards = S.services.map((s) =>
    h("button", {
      class: "svc", type: "button",
      onclick: () => actions.addLine({ name: s.name, price: Number(s.price) }),
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

  const draftRows = S.draft.lines.map((l) =>
    h("div", { class: "dline" },
      h("span", { class: "tr", text: l.name }),
      inp({ type: "number", min: "0", step: "1", value: String(l.qty),
            "aria-label": "Kogus", oninput: (e) => actions.updateLine(l.key, { qty: parseNum(e.target.value) }) }),
      inp({ type: "number", min: "0", step: "0.01", value: String(l.price),
            "aria-label": "Hind", oninput: (e) => actions.updateLine(l.key, { price: parseNum(e.target.value) }) }),
      h("button", { class: "del", type: "button", title: "Eemalda rida",
                    onclick: () => actions.removeLine(l.key) }, "×")
    )
  );

  return [
    head("Uus arve · " + expectedNr(), "Kiirmüük",
      h("button", { class: "btng", type: "button", onclick: actions.clearDraft }, "Tühjenda")
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
          h("p", { class: "thr", text: expectedNr(), style: "margin:0" })
        ),

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
        h("div", { class: "seg" },
          ...[["cash", "Sularaha"], ["card", "Kaart"], ["split", "Jaga"]].map(([value, label]) =>
            h("button", {
              type: "button", class: S.draft.method === value ? "on" : "",
              "aria-pressed": String(S.draft.method === value),
              onclick: () => actions.setMethod(value),
            }, label)
          )
        ),

        h("div", { class: "formrow", style: "margin-top:10px" },
          field("Sularahas", inp({ id: "posCash", type: "number", min: "0", step: "0.01", value: String(S.draft.cash),
            disabled: S.draft.method !== "split",
            oninput: (e) => actions.setPayment({ cash: parseNum(e.target.value) }) })),
          field("Kaardiga", inp({ id: "posCard", type: "number", min: "0", step: "0.01", value: String(S.draft.card),
            disabled: S.draft.method !== "split",
            oninput: (e) => actions.setPayment({ card: parseNum(e.target.value) }) }))
        ),

        h("p", { id: "posErr", class: "err", style: "margin:10px 0 0" },
          S.draft.lines.length && mismatch !== 0
            ? "Vahe " + num(Math.abs(mismatch) / 100) + " € — sularaha ja kaart kokku peavad võrduma summaga."
            : ""),

        h("button", {
          id: "posFinish", class: "btnp wide", type: "button", style: "margin-top:10px",
          disabled: !S.draft.lines.length || mismatch !== 0,
          onclick: actions.finishSale,
        }, "Lõpeta müük")
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

  const rows = S.invoices.map((i) =>
    h("div", {
      class: "row click" + (selected && i.id === selected.id ? " sel" : ""),
      style: "grid-template-columns:1fr auto",
      onclick: () => actions.openInvoice(i.id),
    },
      h("div", {},
        h("div", { class: "tr mono" },
          i.nr,
          isCancelled(i) ? h("span", { class: "pill neg", style: "margin-left:8px", text: "Tühistatud" }) : null
        ),
        h("div", { class: "thr", style: "margin-top:3px",
                   text: dateET(i.invoice_date) + " · " + lineSummary(i) })
      ),
      h("span", { class: "tr mono r" + (isCancelled(i) ? " dim struck" : ""), text: eur(i.total) })
    )
  );

  return [
    head(S.invoices.length + " arvet", "Arved",
      h("button", { class: "btng", type: "button", disabled: !selected, onclick: () => window.print() },
        "Trüki / PDF"),
      h("button", {
        class: "btng", type: "button",
        disabled: !selected || isCancelled(selected),
        onclick: () => selected && actions.cancelInvoice(selected),
      }, selected && isCancelled(selected) ? "Tühistatud" : "Tühista arve"),
      h("button", { class: "btnp", type: "button", onclick: () => actions.goto("pos") }, "+ Uus müük")
    ),

    h("div", { class: "cols cinv" },
      h("div", { class: "noprint" },
        table("1fr auto", ["Arve", { label: "Summa", r: true }], rows, "Arveid veel pole."),
        h("p", { class: "lab", style: "color:var(--tx3);font-weight:400;margin:12px 0 0;line-height:1.5" },
          "Arve avaneb kõrval A4 lehena. Trüki / PDF saadab printi ainult lehe, ilma liideseta.")
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
    [st.company_email, st.company_web].filter(Boolean).join(" · "),
  ].filter((l) => l && l.trim());

  return h("article", { class: "a4" },
    h("span", { class: "mk tl", text: "+" }), h("span", { class: "mk tr", text: "+" }),
    h("span", { class: "mk bl", text: "+" }), h("span", { class: "mk br", text: "+" }),

    h("div", { class: "a4h" },
      h("img", { class: "a4logo", src: "assets/fi-logo.webp", alt: "Fi Barbershop" }),
      h("div", {},
        h("p", { class: "a4t", text: "Arve" }),
        h("p", { class: "a4nr", text: invoice.nr }),
        h("div", { class: "a4meta" },
          h("div", { text: "Kuupäev " + dateET(invoice.invoice_date) }),
          h("div", { text: "Tähtaeg " + dateET(invoice.due_date) }),
          h("div", { text: "Viitenumber " + String(invoice.nr).replace(/\D/g, "") })
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
      ...(invoice.lines || []).map((l) =>
        h("div", { class: "row", style: "grid-template-columns:1fr 60px 60px 90px 90px" },
          h("span", { class: "tr", text: l.name }),
          h("span", { class: "tr mono r", text: String(Number(l.qty)) }),
          h("span", { class: "tr mono r", text: l.unit }),
          h("span", { class: "tr mono r", text: num(l.price) }),
          h("span", { class: "tr mono r", text: num(Number(l.price) * Number(l.qty)) })
        )
      )
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
      h("div", { text: "Sularaha " + num(invoice.cash) + " · Kaart " + num(invoice.card) }),
      h("div", { text: "Palume tasuda arvel toodud tähtajaks." })
    )
  );
}

// ------------------------------------------------------------ kassaraamat

export function viewLedger(actions) {
  const totals = ledgerTotals();
  const rows = ledgerWithBalance();
  const grid = "70px 66px 1.1fr 1.6fr 90px 90px 100px 100px 30px";

  const form = {
    date: todayISO(), kind: "kulu", category: "Muu", description: "", cash: "", card: "",
  };

  const body = rows.map((e) =>
    h("div", { class: "row", style: "grid-template-columns:" + grid },
      h("span", { class: "tr mono", text: dayMonth(e.entry_date) }),
      h("span", { class: "pill " + (e.kind === "tulu" ? "pos" : "neg"), text: e.kind }),
      h("span", { class: "tr", text: e.category }),
      h("span", { class: "tr", text: e.description }),
      h("span", { class: "tr mono r", text: Number(e.cash) ? num(e.cash) : "–" }),
      h("span", { class: "tr mono r", text: Number(e.card) ? num(e.card) : "–" }),
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
      kpi("Sularahas", eur(totals.cashIn)),
      kpi("Kaardiga", eur(totals.cardIn)),
      kpi("Kulud", (totals.out > 0 ? "−" : "") + eur(totals.out), { cls: totals.out > 0 ? "neg" : "" }),
      kpi("Jääk", eur(totals.balance), { inverse: true })
    ),

    panel({},
      h("p", { class: "thr", text: "Lisa kanne", style: "margin:0 0 12px" }),
      h("div", { class: "formrow" },
        field("Kuupäev", inp({ type: "date", value: form.date, oninput: (e) => (form.date = e.target.value) })),
        field("Tüüp", select({ oninput: (e) => (form.kind = e.target.value) },
          [{ value: "tulu", label: "Tulu" }, { value: "kulu", label: "Kulu" }], form.kind)),
        field("Kategooria", select({ oninput: (e) => (form.category = e.target.value) },
          ["Teenuste müük", "Kaubamüük", "Kaubavaru", "Rent", "Töövahendid", "Palk", "Muu"], form.category)),
        field("Kirjeldus", inp({ type: "text", placeholder: "Nt. salongi üür",
          oninput: (e) => (form.description = e.target.value) })),
        field("Sularaha", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.cash = e.target.value) })),
        field("Kaart", inp({ type: "number", min: "0", step: "0.01", placeholder: "0,00",
          oninput: (e) => (form.card = e.target.value) })),
        h("button", { class: "btnp", type: "button", onclick: () => actions.addLedger(form) }, "+ Lisa")
      )
    ),

    table(grid,
      ["Kuupäev", "Tüüp", "Kategooria", "Kirjeldus",
       { label: "Sularaha", r: true }, { label: "Kaart", r: true },
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

export const VIEWS = {
  dash: viewDash,
  pos: viewPos,
  inv: viewInvoices,
  cash: viewLedger,
  stock: viewStock,
  price: viewPrices,
};
