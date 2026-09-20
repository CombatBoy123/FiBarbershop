// smoke-test.js — end-to-end check of the invoicing rules against a running
// server. Creates a THROWAWAY shop, exercises every flow, and drops it again,
// so the real shop's books are never read or written.
//
//   npm start          (in one terminal)
//   npm run smoke-test (in another)

// End-to-end smoke test against a THROWAWAY shop, created and dropped here.
// The real Fi shop's rows are never read or written.
require("dotenv").config();

const { query, withTransaction, pool, ready } = require("../src/db");
const { hashPassword, signToken } = require("../src/auth");
const { seedDefaults } = require("../src/seed");

const BASE = process.env.SMOKE_BASE || ("http://localhost:" + (process.env.PORT || 4100));
const EMAIL = "arveldus-test-" + Date.now() + "@example.invalid";
const BARBER = "barber-test-" + Date.now() + "@example.invalid";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  VIGA " + name + (extra ? "  ->  " + extra : "")); }
};

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: Object.assign(
      token ? { Authorization: "Bearer " + token } : {},
      body ? { "Content-Type": "application/json" } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, data: data };
}

(async () => {
  await ready;
  let shopId = null;
  try {
    const made = await withTransaction(async (c) => {
      const u = await c.query(
        "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,'Testomanik','omanik') RETURNING id, email",
        [EMAIL, await hashPassword("x".repeat(24))]
      );
      await c.query("UPDATE users SET shop_id = id WHERE id = $1", [u.rows[0].id]);
      await seedDefaults(c, u.rows[0].id);
      const b = await c.query(
        "INSERT INTO users (email, password_hash, name, shop_id, role) VALUES ($1,$2,'Testbarber',$3,'barber') RETURNING id, email",
        [BARBER, await hashPassword("y".repeat(24)), u.rows[0].id]
      );
      return { owner: u.rows[0], barber: b.rows[0] };
    });
    shopId = made.owner.id;
    const OT = signToken(made.owner);
    const BT = signToken(made.barber);
    console.log("\nTestsalong loodud, id " + shopId + "\n");

    console.log("1. Salong ja rollid");
    const so = await call(OT, "GET", "/api/bootstrap");
    const sb = await call(BT, "GET", "/api/bootstrap");
    ok("omanik saab töölaua", so.status === 200, so.status);
    ok("barber saab töölaua", sb.status === 200, sb.status);
    ok("barber näeb sama hinnakirja (mitte tühja salongi)",
      sb.data && so.data && sb.data.services.length === so.data.services.length);
    ok("roll jõuab kliendini", sb.data.me.role === "barber", sb.data.me && sb.data.me.role);

    const svc = so.data.services[0];
    const prod = so.data.products.find((p) => p.stock > 0) || so.data.products[0];

    console.log("\n2. Paindlikud read");
    const sale = await call(BT, "POST", "/api/sales", {
      lines: [
        { serviceId: svc.id, name: "Juukselõikus", qty: 1, price: 35 },
        { serviceId: svc.id, name: "Juukselõikus (erihind)", qty: 1, price: 40, note: "Püsikliendi hind" },
        { serviceId: svc.id, name: "Juukselõikus", qty: 3, price: 35, discount: 10, unit: "kord", note: "Nädala koondarve" },
      ],
      cash: 0, card: 169.5,
    });
    ok("barber saab müügi teha", sale.status === 201, JSON.stringify(sale.data).slice(0, 140));
    const inv1 = sale.data && sale.data.invoice;
    ok("summa arvutatud allahindlusega (35 + 40 + 94,50 = 169,50)",
      inv1 && Number(inv1.total) === 169.5, inv1 && inv1.total);
    const l1 = sale.data.state.invoices.find((i) => i.id === inv1.id).lines;
    ok("sama teenus kolmel real eri hinnaga", l1.length === 3, l1.length);
    ok("kohandatud nimi salvestus", l1[1].name === "Juukselõikus (erihind)", l1[1].name);
    ok("selgitus salvestus", l1[2].note === "Nädala koondarve", l1[2].note);
    ok("allahindlus salvestus", Number(l1[2].discount) === 10, l1[2].discount);
    ok("ühik salvestus", l1[2].unit === "kord", l1[2].unit);
    ok("teenuse side salvestus", l1[0].service_id === svc.id, l1[0].service_id);
    const svcNow = (await call(OT, "GET", "/api/bootstrap")).data.services.find((s) => s.id === svc.id);
    ok("HINNAKIRI EI MUUTUNUD (40 EUR ei liikunud hinnakirja)",
      Number(svcNow.price) === Number(svc.price), svcNow.price + " vs " + svc.price);

    console.log("\n3. Mustand ja koondarve");
    const draft = await call(BT, "POST", "/api/invoices", {
      buyerName: "Testklient OÜ", buyerDetails: "11111111",
      lines: [{ serviceId: svc.id, name: "Juukselõikus", qty: 2, price: 35, note: "Esmaspäev" }],
    });
    ok("mustandi loomine", draft.status === 201, JSON.stringify(draft.data).slice(0, 140));
    const dId = draft.data.invoice.id;
    ok("mustandil ei ole numbrit", !draft.data.invoice.nr, draft.data.invoice.nr);
    ok("mustand ei kirjuta kassaraamatusse",
      !draft.data.state.ledger.some((e) => e.invoice_id === dId));

    const upd = await call(BT, "PUT", "/api/invoices/" + dId, {
      buyerName: "Testklient OÜ", buyerDetails: "11111111",
      lines: [
        { serviceId: svc.id, name: "Juukselõikus", qty: 2, price: 35, note: "Esmaspäev" },
        { serviceId: svc.id, name: "Juukselõikus", qty: 1, price: 40, discount: 10, note: "Reede" },
      ],
    });
    ok("mustandit saab täiendada", upd.status === 200, JSON.stringify(upd.data).slice(0, 140));
    ok("uus summa 70 + 36 = 106", Number(upd.data.invoice.total) === 106, upd.data.invoice.total);

    const issued = await call(BT, "POST", "/api/invoices/" + dId + "/issue", { payNow: false });
    ok("KOONDARVE ESITAMINE MAKSMATA (see oli varem voimatu)", issued.status === 200,
      JSON.stringify(issued.data).slice(0, 160));
    ok("number eraldati esitamisel",
      issued.data.invoice && /^\d{4}-\d{3}$/.test(issued.data.invoice.nr),
      issued.data.invoice && issued.data.invoice.nr);
    ok("olek = esitatud", issued.data.invoice.status === "esitatud", issued.data.invoice.status);
    ok("maksmata arve EI kirjuta kassaraamatusse",
      !issued.data.state.ledger.some((e) => e.invoice_id === dId));

    const paid = await call(OT, "POST", "/api/invoices/" + dId + "/pay", {});
    ok("makstuks markimine", paid.status === 200, JSON.stringify(paid.data).slice(0, 140));
    ok("olek = makstud", paid.data.invoice.status === "makstud", paid.data.invoice.status);
    const led = paid.data.state.ledger.find((e) => e.invoice_id === dId);
    ok("KASSAKANNE TEKIB ALLES MAKSMISEL", Boolean(led));
    ok("ulekanne laheb oma veergu, mitte sularahaks",
      led && Number(led.bank) === 106 && Number(led.cash) === 0,
      led && "bank=" + led.bank + " cash=" + led.cash);

    console.log("\n4. Õigused");
    const bCancel = await call(BT, "POST", "/api/invoices/" + inv1.id + "/cancel", { reason: "test" });
    ok("BARBER EI SAA ARVET TÜHISTADA (403)", bCancel.status === 403, bCancel.status);
    ok("barber ei saa hinnakirja muuta",
      (await call(BT, "PUT", "/api/services/" + svc.id, { price: 1 })).status === 403);
    ok("barber ei saa seadeid muuta",
      (await call(BT, "PUT", "/api/settings", { vat_rate: 0 })).status === 403);
    ok("barber ei saa kassaraamatu kannet lisada",
      (await call(BT, "POST", "/api/ledger", { kind: "kulu", cash: 5 })).status === 403);
    ok("barber ei saa kontot luua",
      (await call(BT, "POST", "/api/staff", { email: "x@example.invalid", password: "zzzzzzzz" })).status === 403);
    const bDraft = await call(BT, "POST", "/api/invoices", { lines: [{ name: "Test", qty: 1, price: 1 }] });
    ok("barber SAAB mustandi teha (see on ohutu)", bDraft.status === 201, bDraft.status);
    ok("mustandi kustutamine onnestub",
      (await call(BT, "DELETE", "/api/invoices/" + bDraft.data.invoice.id)).status === 200);

    console.log("\n5. Kustutamine ja tühistamine");
    const delIssued = await call(OT, "DELETE", "/api/invoices/" + inv1.id);
    ok("ESITATUD ARVET EI SAA KUSTUTADA (409)", delIssued.status === 409, delIssued.status);
    const noReason = await call(OT, "POST", "/api/invoices/" + inv1.id + "/cancel", { reason: "  " });
    ok("pohjuseta tuhistamine keelatud (400)", noReason.status === 400, noReason.status);
    const cancelled = await call(OT, "POST", "/api/invoices/" + inv1.id + "/cancel", { reason: "Vale klient" });
    ok("omanik saab tuhistada", cancelled.status === 200, JSON.stringify(cancelled.data).slice(0, 140));
    const cInv = cancelled.data.state.invoices.find((i) => i.id === inv1.id);
    ok("number jaab alles", cInv.nr === inv1.nr, cInv.nr);
    ok("olek = tuhistatud", cInv.status === "tühistatud", cInv.status);
    ok("kassakanne keeratud tagasi",
      !cancelled.data.state.ledger.some((e) => e.invoice_id === inv1.id));

    const un = await call(OT, "POST", "/api/invoices/" + inv1.id + "/uncancel", {});
    ok("tuhistamise saab 24h jooksul tagasi votta", un.status === 200, JSON.stringify(un.data).slice(0, 140));
    ok("kassakanne taastatud", un.data.state.ledger.some((e) => e.invoice_id === inv1.id));

    console.log("\n6. Kontod, kliendid, auditijälg");
    const staff = await call(OT, "POST", "/api/staff", {
      email: "uus-" + Date.now() + "@example.invalid", password: "zzzzzzzzzz", name: "Uus", role: "barber",
    });
    ok("omanik saab konto luua", staff.status === 201, JSON.stringify(staff.data).slice(0, 140));
    ok("uus konto kuulub samasse salongi",
      staff.data.state.staff.some((u) => u.id === staff.data.user.id));
    const self = await call(OT, "PUT", "/api/staff/" + made.owner.id, { role: "barber" });
    ok("omanik ei saa iseennast alandada (409)", self.status === 409, self.status);

    const cust = await call(OT, "POST", "/api/customers", { name: "Metsa Ehitus OÜ", details: "14785236" });
    ok("kliendi lisamine", cust.status === 201, JSON.stringify(cust.data).slice(0, 140));
    const cId = cust.data.customer.id;
    const cp = await call(OT, "PUT", "/api/customers/" + cId + "/prices/" + svc.id, { price: 40 });
    ok("kliendi erihinna salvestamine", cp.status === 200, JSON.stringify(cp.data).slice(0, 140));
    const cAfter = cp.data.state.customers.find((c) => c.id === cId);
    ok("erihind loetav", Number(cAfter.prices[svc.id]) === 40, JSON.stringify(cAfter.prices));
    const svcStill = cp.data.state.services.find((s) => s.id === svc.id);
    ok("kliendi erihind EI muuda hinnakirja",
      Number(svcStill.price) === Number(svc.price), svcStill.price);

    const audit = (await call(OT, "GET", "/api/bootstrap")).data.audit;
    ok("auditijalg kirjutab tuhistamise", audit.some((a) => a.action === "arve tühistatud"));
    ok("auditijalg kirjutab konto loomise", audit.some((a) => a.action === "konto loodud"));
    ok("auditijalg naitab tegijat", audit[0] && Boolean(audit[0].actor_email || audit[0].actor_name));

    if (prod) {
      console.log("\n7. Ladu");
      // A freshly seeded shop has an empty shelf, so book stock in first —
      // selling from nothing is refused, and that refusal is itself correct.
      const empty = await call(BT, "POST", "/api/sales", {
        lines: [{ productId: prod.id, name: prod.name, qty: 1, price: Number(prod.price) }],
        cash: Number(prod.price), card: 0,
      });
      ok("tuhjast laost ei saa muua (409)", empty.status === 409, empty.status);

      const inMove = await call(OT, "POST", "/api/stock-movements", {
        productId: prod.id, type: "in", qty: 5, price: Number(prod.cost) || 0,
      });
      ok("omanik saab kaupa sisse kanda", inMove.status === 201, JSON.stringify(inMove.data).slice(0, 140));

      const ps = await call(BT, "POST", "/api/sales", {
        lines: [{ productId: prod.id, name: prod.name, qty: 1, price: Number(prod.price) }],
        cash: Number(prod.price), card: 0,
      });
      ok("toote muuk", ps.status === 201, JSON.stringify(ps.data).slice(0, 140));
      if (ps.status === 201) {
        const stockOf = (st) => st.products.find((p) => p.id === prod.id).stock;
        ok("laojaak vahenes 5 -> 4", stockOf(ps.data.state) === 4, "jaak " + stockOf(ps.data.state));

        // Cancelling must put the jar back on the shelf.
        const c2 = await call(OT, "POST", "/api/invoices/" + ps.data.invoice.id + "/cancel",
          { reason: "Test: ladu tagasi" });
        ok("tuhistamine annab kauba lattu tagasi",
          c2.status === 200 && stockOf(c2.data.state) === 5,
          c2.status === 200 ? "jaak " + stockOf(c2.data.state) : c2.status);
      }
    }
    console.log("\n8. Admini õigused: jäädav kustutamine ja paroolid");
    const mkSale = async (label) => {
      const r = await call(BT, "POST", "/api/sales", {
        lines: [{ serviceId: svc.id, name: label, qty: 1, price: 10 }],
        cash: 10, card: 0,
      });
      return r.data.invoice;
    };
    const seq = (nr) => Number(String(nr).split("-")[1]) || 0;
    const a = await mkSale("Kustutustest A");
    const b2 = await mkSale("Kustutustest B");
    ok("kaks jarjestikust numbrit", seq(b2.nr) === seq(a.nr) + 1, a.nr + " -> " + b2.nr);

    ok("barber ei saa jaadavalt kustutada (403)",
      (await call(BT, "DELETE", "/api/invoices/" + a.id + "/permanent")).status === 403);

    // Kuu keskelt, ilma eelneva tuhistamiseta: lubatud, aga jatab augu ja
    // peab kassakande ise ara koristama.
    const mid = await call(OT, "DELETE", "/api/invoices/" + a.id + "/permanent");
    ok("OMANIK SAAB KUSTUTADA TUHISTAMATA ARVE", mid.status === 200,
      JSON.stringify(mid.data).slice(0, 140));
    ok("server utleb, et jai auk", mid.data.leavesGap === true, String(mid.data.leavesGap));
    ok("arve on raamatust kadunud", !mid.data.state.invoices.some((i) => i.id === a.id));
    ok("KASSAKANNE LAKS KAASA (kassaraamatusse ei jaanud olematut muuki)",
      !mid.data.state.ledger.some((e) => e.invoice_id === a.id));
    ok("auditijalg sailitas numbri, ostja ja summa",
      mid.data.state.audit.some((x) => x.detail && String(x.detail).indexOf(a.nr) === 0
        && String(x.detail).indexOf("ei olnud tühistatud") > 0));

    const c3 = await mkSale("Kustutustest C");
    ok("keskelt kustutatud numbrit ei anta uuesti (auk jaab, nagu hoiatati)",
      seq(c3.nr) === seq(b2.nr) + 1, a.nr + " kustutatud, jargmine sai " + c3.nr);

    // Kuu viimane: number vabaneb ja auku ei teki.
    const lastPurge = await call(OT, "DELETE", "/api/invoices/" + c3.id + "/permanent");
    ok("kuu viimase saab samuti kustutada", lastPurge.status === 200,
      JSON.stringify(lastPurge.data).slice(0, 140));
    ok("server utleb, et auku ei jaanud", lastPurge.data.leavesGap === false,
      String(lastPurge.data.leavesGap));
    const d4 = await mkSale("Kustutustest D");
    ok("LOENDUR KEERATI TAGASI: vabanenud number antakse uuesti",
      d4.nr === c3.nr, c3.nr + " kustutatud, jargmine sai " + d4.nr);

    const wrongPw = await call(BT, "PUT", "/api/me/password", { current: "vale", password: "uusparool123" });
    ok("vale praeguse parooliga ei vaheta (401)", wrongPw.status === 401, wrongPw.status);
    const myPw = await call(BT, "PUT", "/api/me/password", { current: "y".repeat(24), password: "uusparool123" });
    ok("oma parooli vahetamine onnestub", myPw.status === 200, JSON.stringify(myPw.data).slice(0, 110));
    ok("liiga luhike parool keelatud (400)",
      (await call(BT, "PUT", "/api/me/password", { current: "uusparool123", password: "lyhike" })).status === 400);

    ok("barber ei saa teise parooli lahtestada (403)",
      (await call(BT, "PUT", "/api/staff/" + made.owner.id + "/password", { password: "misiganes123" })).status === 403);
    const reset = await call(OT, "PUT", "/api/staff/" + made.barber.id + "/password", { password: "omanikupandud123" });
    ok("omanik saab barberi parooli lahtestada", reset.status === 200, JSON.stringify(reset.data).slice(0, 110));
    ok("lahtestamine laheb auditijalge",
      reset.data.state.audit.some((x) => x.action === "parool lähtestatud"));
    console.log("\n9. Konto kaupa lülitid");
    const perms = (o) => Object.assign({ cust: false, price: false, cash: false, stock: false, admin: false }, o);
    const meOf = async (t) => (await call(t, "GET", "/api/bootstrap")).data.me;

    const before = await meOf(BT);
    ok("barberil on vaikimisi Kliendid lubatud", before.can.cust === true, JSON.stringify(before.can));
    ok("barberil on vaikimisi Hinnakiri keelatud", before.can.price === false);
    ok("omanikul on koik lubatud", Object.values((await meOf(OT)).can).every(Boolean));

    ok("barber ei saa ise oigusi muuta (403)",
      (await call(BT, "PUT", "/api/staff/" + made.barber.id + "/permissions",
        { permissions: perms({ price: true }) })).status === 403);
    ok("omaniku oigusi ei saa piirata (409)",
      (await call(OT, "PUT", "/api/staff/" + made.owner.id + "/permissions",
        { permissions: perms({}) })).status === 409);

    const grant = await call(OT, "PUT", "/api/staff/" + made.barber.id + "/permissions",
      { permissions: perms({ cust: true, price: true }) });
    ok("omanik saab lulitit keerata", grant.status === 200, JSON.stringify(grant.data).slice(0, 140));
    ok("HINNAKIRI LUBATUD -> barber saab hinda muuta",
      (await call(BT, "PUT", "/api/services/" + svc.id, { price: 33 })).status === 200);
    ok("bootstrap naitab uut oigust", (await meOf(BT)).can.price === true);
    ok("keelatud alad jaid endiselt kinni",
      (await call(BT, "POST", "/api/ledger", { kind: "kulu", cash: 5 })).status === 403);

    const revoke = await call(OT, "PUT", "/api/staff/" + made.barber.id + "/permissions",
      { permissions: perms({ price: true }) });
    ok("lulitit saab ka tagasi keerata", revoke.status === 200);
    ok("KLIENDID KEELATUD -> barber saab 403",
      (await call(BT, "POST", "/api/customers", { name: "Ei tohiks tekkida" })).status === 403);
    ok("bootstrap naitab keeldu", (await meOf(BT)).can.cust === false);
    ok("oiguste muutmine laks auditijalge",
      revoke.data.state.audit.some((x) => x.action === "õigused muudetud"));

    // Muudatus kehtib kohe, mitte tokeni eluea taga: konto rida loetakse igal paringul.
    ok("vana token tunneb uut oigust kohe",
      (await call(BT, "PUT", "/api/services/" + svc.id, { price: 34 })).status === 200);
    console.log("\n10. Barberite hinnad");
    const boot2 = (await call(OT, "GET", "/api/bootstrap")).data;
    ok("uus salong sai barberid kaasa", boot2.barbers.length === 5, boot2.barbers.length);
    const jax = boot2.barbers.find((b) => b.slug === "jax");
    const joss = boot2.barbers.find((b) => b.slug === "joss");
    const hair = boot2.services.find((s) => s.name === "Juukselõikus");
    const beard = boot2.services.find((s) => s.name === "Habe + juukselõikus");
    ok("Jaxi juukseloikus on 30, mitte salongi 35",
      Number(jax.prices[hair.id].price) === 30, jax.prices[hair.id] && jax.prices[hair.id].price);
    ok("Joss ei paku habemetood", joss.prices[beard.id].offered === false,
      JSON.stringify(joss.prices[beard.id]));

    const ch = await call(OT, "PUT", "/api/barbers/" + jax.id + "/prices/" + hair.id,
      { price: 32, offered: true });
    ok("omanik saab barberi hinda muuta", ch.status === 200, JSON.stringify(ch.data).slice(0, 130));
    ok("uus hind on seisus",
      Number(ch.data.state.barbers.find((b) => b.id === jax.id).prices[hair.id].price) === 32);
    ok("SALONGI TAVAHIND EI MUUTUNUD",
      Number(ch.data.state.services.find((s) => s.id === hair.id).price) === Number(hair.price),
      hair.price + " -> " + ch.data.state.services.find((s) => s.id === hair.id).price);

    const off = await call(OT, "PUT", "/api/barbers/" + jax.id + "/prices/" + beard.id,
      { price: 0, offered: false });
    ok("teenuse saab barberi alt ara votta", off.status === 200);
    ok("offered = false jai kirja",
      off.data.state.barbers.find((b) => b.id === jax.id).prices[beard.id].offered === false);

    // Osa 9 jattis barberile Hinnakirja oiguse sisse; vota see enne ara, et
    // kontrollida just selle lulitit ja mitte eelmise osa jaanust.
    await call(OT, "PUT", "/api/staff/" + made.barber.id + "/permissions",
      { permissions: perms({ cust: true }) });
    ok("ilma Hinnakirja oiguseta barber ei saa muuta (403)",
      (await call(BT, "PUT", "/api/barbers/" + jax.id + "/prices/" + hair.id,
        { price: 1, offered: true })).status === 403);
    await call(OT, "PUT", "/api/staff/" + made.barber.id + "/permissions",
      { permissions: perms({ price: true }) });
    ok("Hinnakirja oigusega saab",
      (await call(BT, "PUT", "/api/barbers/" + jax.id + "/prices/" + hair.id,
        { price: 31, offered: true })).status === 200);

    const link = await call(OT, "PUT", "/api/barbers/" + jax.id, { accountId: made.barber.id });
    ok("barberi saab konto kulge siduda", link.status === 200, JSON.stringify(link.data).slice(0, 130));
    ok("seos on seisus loetav",
      link.data.state.barbers.find((b) => b.id === jax.id).account_id === made.barber.id);

    const added = await call(OT, "POST", "/api/barbers", { name: "Barber Test", tier: "Rookie" });
    ok("uue barberi lisamine", added.status === 201, JSON.stringify(added.data).slice(0, 130));
    ok("uus barber alustab salongi hinnakirjaga",
      Number(added.data.state.barbers.find((b) => b.id === added.data.barber.id)
        .prices[hair.id].price) === Number(hair.price));
    ok("barberi saab eemaldada",
      (await call(OT, "DELETE", "/api/barbers/" + added.data.barber.id)).status === 200);
  } finally {
    if (shopId) {
      await query("DELETE FROM users WHERE shop_id = $1 OR id = $1", [shopId]);
      console.log("\nTestsalong kustutatud (kaskaad viis koik testandmed kaasa).");
    }
    console.log("\n==================================");
    console.log("  KORRAS: " + pass + "   VIGA: " + fail);
    console.log("==================================");
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error("TESTI ENDA VIGA:", e); process.exit(2); });
