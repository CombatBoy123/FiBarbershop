// barber-addon.js — self-contained barber picker for the till.
//
// A single bolt-on file: it does NOT modify any of the app's own modules.
// The only wiring it needs is one <script> tag in app.html. It injects its
// own styles and adds the barber selector to the navbar. On the Kiirmüük
// screen it stamps the active barber onto the "Uus arve" header and greys
// out (strikes through) the service tiles the chosen barber does not offer,
// so the operator keeps the shop's full clickable service row but can only
// pick services that barber actually performs.

(function () {
  "use strict";

  // ------------------------------------------------------------ data
  var BARBERS = [
    { id: "remm", displayName: "Barber Remm", tier: "Meister", isDefault: true, phone: null,
      services: [
        { name: "Habe + Juukselõikus", price: { type: "range", min: 40, max: 50 }, durationMin: 45, isAddOn: false },
        { name: "Juukselõikus",        price: { type: "fixed", amount: 35 },       durationMin: 45, isAddOn: false },
        { name: "Design / hairtattoo", price: { type: "free" },                    durationMin: 45, isAddOn: true },
        { name: "Afterhours (DM)",     price: { type: "surcharge", amount: 10 },   durationMin: 45, isAddOn: true },
      ] },
    { id: "jax", displayName: "Barber Jax", tier: "Spetsialist", isDefault: false, phone: null,
      services: [
        { name: "Habe + Juukselõikus", price: { type: "range", min: 35, max: 40 }, durationMin: 45, isAddOn: false },
        { name: "Juukselõikus",        price: { type: "fixed", amount: 30 },       durationMin: 45, isAddOn: false },
        { name: "Design / hairtattoo", price: { type: "surcharge", amount: 5 },    durationMin: 45, isAddOn: true },
        { name: "Afterhours (DM)",     price: { type: "surcharge", amount: 5 },    durationMin: 45, isAddOn: true },
      ] },
    { id: "ogfadedoctor", displayName: "OGfadedoctor", tier: "Külalisbarber", isDefault: false, phone: "5685 2919",
      services: [
        { name: "Tartu lõikuspäev", price: { type: "fixed", amount: 30 }, durationMin: 45, isAddOn: false },
      ] },
    { id: "kristo", displayName: "Barber Kristo", tier: "Rookie", isDefault: false, phone: null,
      services: [
        { name: "Juukselõikus", price: { type: "scheduled", schedule: [
          { amount: 10, effectiveFrom: null }, { amount: 15, effectiveFrom: "2026-09-01" } ] }, durationMin: 60, isAddOn: false },
        { name: "Design / hairtattoo",    price: { type: "free" },                  durationMin: 60, isAddOn: true },
        { name: "Afterhours / ületunnid", price: { type: "surcharge", amount: 10 }, durationMin: 60, isAddOn: true },
      ] },
    { id: "joss", displayName: "Barber Joss", tier: "Rookie", isDefault: false, phone: null,
      services: [
        { name: "Juukselõikus", price: { type: "fixed", amount: 10 }, durationMin: 90, isAddOn: false },
      ] },
  ];

  var byId = {};
  BARBERS.forEach(function (b) { byId[b.id] = b; });
  function defaultBarber() { return BARBERS.filter(function (b) { return b.isDefault; })[0] || BARBERS[0]; }

  // ------------------------------------------------------------ helpers
  function parseLocalDate(iso) {
    if (!iso) return null;
    var p = String(iso).split("-");
    return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
  }
  function resolveScheduled(price, now) {
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var entries = (price.schedule || []).slice().sort(function (a, b) {
      var da = parseLocalDate(a.effectiveFrom), db = parseLocalDate(b.effectiveFrom);
      if (!da && !db) return 0; if (!da) return -1; if (!db) return 1; return da - db;
    });
    var cur = null;
    entries.forEach(function (e) { var f = parseLocalDate(e.effectiveFrom); if (!f || f <= today) cur = e; });
    if (!cur && entries.length) cur = entries[0];
    return cur ? cur.amount : 0;
  }
  function startingPrice(b, now) {
    now = now || new Date();
    var min = null;
    (b.services || []).forEach(function (s) {
      if (s.isAddOn) return;
      var a = s.price.type === "range" ? s.price.min
        : s.price.type === "scheduled" ? resolveScheduled(s.price, now)
        : s.price.type === "free" ? 0 : s.price.amount;
      if (a != null && (min === null || a < min)) min = a;
    });
    return min;
  }

  // Classify a service name (from either the barber data or a shop tile) into a
  // category, so a barber's offering can be matched against the shop's tiles
  // even when the wording differs (e.g. "Tartu lõikuspäev" is a haircut).
  function category(name) {
    var n = String(name || "").toLowerCase();
    if (n.indexOf("habe") >= 0) return "beard";
    if (n.indexOf("design") >= 0 || n.indexOf("tattoo") >= 0) return "design";
    if (n.indexOf("afterhour") >= 0 || n.indexOf("ületund") >= 0 || n.indexOf("uletund") >= 0) return "afterhours";
    if (n.indexOf("tervitusjook") >= 0 || n.indexOf("welcome") >= 0 || n.indexOf("drink") >= 0) return "welcomedrink";
    if (n.indexOf("muu") >= 0 || n.indexOf("käsitsi") >= 0 || n.indexOf("kasitsi") >= 0 || n.indexOf("manual") >= 0) return "manual";
    if (n.indexOf("lõik") >= 0 || n.indexOf("loik") >= 0 || n.indexOf("haircut") >= 0) return "haircut";
    return null;
  }

  // Only real barber treatments are ever struck. A haircut is offered by every
  // barber, and the welcome drink and the manual "Muu" line are shop-wide, so
  // none of those is ever crossed out.
  var STRIKEABLE = { beard: true, design: true, afterhours: true };

  function offeredCategories(b) {
    var set = {};
    (b.services || []).forEach(function (s) { var c = category(s.name); if (c) set[c] = true; });
    return set;
  }

  // The barber's own service in a given category (or null), so a shop tile can
  // be repriced to this barber's price.
  function barberServiceForCategory(b, cat) {
    if (!cat) return null;
    var found = null;
    (b.services || []).forEach(function (s) { if (!found && category(s.name) === cat) found = s; });
    return found;
  }

  // The numeric price dropped into the draft when a tile is clicked.
  function priceAmount(price, now) {
    now = now || new Date();
    switch (price.type) {
      case "fixed": return price.amount;
      case "range": return price.min;           // adds the lower bound; editable in the draft
      case "free": return 0;
      case "surcharge": return price.amount;
      case "scheduled": return resolveScheduled(price, now);
      default: return 0;
    }
  }

  // Money formatted like the till (comma decimals, e.g. "30,00 €"), so the
  // price on the tile is exactly the amount that lands on the invoice.
  function num2(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace(".", ","); }
  function eur(v) { return num2(v) + " €"; }

  // ------------------------------------------------------------ state
  var LS = "fi.activeBarber";
  var activeId = defaultBarber().id;
  try { var saved = localStorage.getItem(LS); if (saved && byId[saved]) activeId = saved; } catch (e) {}
  function active() { return byId[activeId] || defaultBarber(); }
  function setActive(id) {
    if (!byId[id]) return;
    activeId = id;
    try { localStorage.setItem(LS, id); } catch (e) {}
    updateLabel();
    apply();
  }

  // ------------------------------------------------------------ styles
  function injectStyles() {
    if (document.getElementById("fi-bsw-style")) return;
    var s = document.createElement("style");
    s.id = "fi-bsw-style";
    s.textContent = [
      ".barbersel{position:relative;display:flex;align-items:center;flex:none}",
      ".bsel-name{display:flex;align-items:center;max-width:170px;padding:5px 10px;",
      "font:600 12px 'IBM Plex Sans',sans-serif;color:#EDEFF0;background:transparent;",
      "border:1px solid #26313C;border-right:none;cursor:pointer;white-space:nowrap}",
      ".bsel-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".bsel-name:hover{background:#1B232C}",
      ".bsel-caret{padding:5px 8px;font:500 11px 'IBM Plex Mono',monospace;color:#7C8996;",
      "background:transparent;border:1px solid #26313C;cursor:pointer;line-height:1}",
      ".bsel-caret:hover{color:#EDEFF0;background:#1B232C}",
      ".barbersel.open .bsel-caret{color:#EDEFF0}",
      ".bsel-name:focus-visible,.bsel-caret:focus-visible{outline:2px solid var(--acc);outline-offset:2px}",
      ".bsel-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:20;min-width:232px;margin:0;",
      "padding:4px;list-style:none;background:var(--card);border:1px solid var(--line);",
      "box-shadow:0 12px 30px rgba(0,0,0,.28)}",
      ".bsel-opt{display:grid;grid-template-columns:1fr auto;align-items:center;gap:1px 10px;",
      "padding:8px 10px;cursor:pointer}",
      ".bsel-opt:hover,.bsel-opt[aria-selected='true']{background:var(--panel)}",
      ".bsel-opt:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}",
      ".bsel-opt-name{font:600 13.5px 'IBM Plex Sans',sans-serif;color:var(--tx)}",
      ".bsel-opt-meta{grid-column:1;font:400 11px 'IBM Plex Mono',monospace;letter-spacing:.04em;color:var(--tx3)}",
      ".bsel-check{grid-column:2;grid-row:1 / span 2;color:var(--acc);font-weight:700;opacity:0}",
      ".bsel-opt[aria-selected='true'] .bsel-check{opacity:1}",
      // a service this barber does not offer: struck through, dimmed, not clickable
      ".svc.fi-unavail{opacity:.45;cursor:not-allowed}",
      ".svc.fi-unavail:hover{border-color:var(--line)}",
      ".svc.fi-unavail .svcn{text-decoration:line-through}",
      "@media (max-width:760px){.bsel-name{max-width:112px}}",
    ].join("");
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------ tiny DOM helper
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------------ navbar selector
  var menuOpen = false, selRoot = null;

  function buildSelector() {
    if (selRoot && document.body.contains(selRoot)) return;
    var navright = document.querySelector(".navright");
    if (!navright) return;

    var wrap = el("div", "barbersel");
    var nameBtn = el("button", "bsel-name");
    nameBtn.type = "button";
    nameBtn.setAttribute("aria-haspopup", "listbox");
    nameBtn.setAttribute("aria-expanded", "false");
    nameBtn.title = "Aktiivne barber — piirab valitavaid teenuseid";
    nameBtn.appendChild(el("span", "bsel-text", active().displayName));

    var caret = el("button", "bsel-caret");
    caret.type = "button";
    caret.setAttribute("aria-label", "Vali barber");
    caret.tabIndex = -1;
    caret.textContent = "▾";

    var menu = el("ul", "bsel-menu");
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Barber");
    menu.hidden = true;

    BARBERS.forEach(function (b) {
      var sp = startingPrice(b);
      var li = el("li", "bsel-opt");
      li.setAttribute("role", "option");
      li.dataset.id = b.id;
      li.setAttribute("aria-selected", b.id === activeId ? "true" : "false");
      li.tabIndex = -1;
      li.appendChild(el("span", "bsel-opt-name", b.displayName));
      li.appendChild(el("span", "bsel-opt-meta", b.tier + (sp != null ? " · alates " + sp + " €" : "")));
      li.appendChild(el("span", "bsel-check", "✓"));
      li.addEventListener("click", function () { setActive(b.id); closeMenu(true); });
      li.addEventListener("keydown", function (e) { onOptKey(e, b.id); });
      menu.appendChild(li);
    });

    nameBtn.addEventListener("click", toggleMenu);
    caret.addEventListener("click", toggleMenu);
    nameBtn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
    });

    wrap.append(nameBtn, caret, menu);
    var tgl = navright.querySelector(".tgl");
    if (tgl) navright.insertBefore(wrap, tgl);
    else navright.appendChild(wrap);
    selRoot = wrap;
  }

  function updateLabel() {
    if (!selRoot) return;
    var t = selRoot.querySelector(".bsel-text");
    if (t) t.textContent = active().displayName;
    selRoot.querySelectorAll(".bsel-opt").forEach(function (o) {
      o.setAttribute("aria-selected", o.dataset.id === activeId ? "true" : "false");
    });
  }
  function openMenu() {
    if (menuOpen || !selRoot) return;
    menuOpen = true;
    selRoot.querySelector(".bsel-menu").hidden = false;
    selRoot.querySelector(".bsel-name").setAttribute("aria-expanded", "true");
    selRoot.classList.add("open");
    var sel = selRoot.querySelector('.bsel-opt[aria-selected="true"]') || selRoot.querySelector(".bsel-opt");
    if (sel) sel.focus();
    document.addEventListener("mousedown", onDocDown, true);
  }
  function closeMenu(returnFocus) {
    if (!menuOpen || !selRoot) return;
    menuOpen = false;
    selRoot.querySelector(".bsel-menu").hidden = true;
    selRoot.querySelector(".bsel-name").setAttribute("aria-expanded", "false");
    selRoot.classList.remove("open");
    document.removeEventListener("mousedown", onDocDown, true);
    if (returnFocus) selRoot.querySelector(".bsel-name").focus();
  }
  function toggleMenu() { if (menuOpen) closeMenu(true); else openMenu(); }
  function onDocDown(e) { if (selRoot && !selRoot.contains(e.target)) closeMenu(false); }
  function onOptKey(e, id) {
    var opts = [].slice.call(selRoot.querySelectorAll(".bsel-opt"));
    var i = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (opts[i + 1] || opts[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (opts[i - 1] || opts[opts.length - 1]).focus(); }
    else if (e.key === "Home") { e.preventDefault(); opts[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1].focus(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(id); closeMenu(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
  }

  // ------------------------------------------------------------ Kiirmüük
  // Stamp the barber onto the "Uus arve" eyebrow and strike out the service
  // tiles this barber does not offer. Runs on every re-render of #view (the
  // app rebuilds that node on each action) and on every barber change.
  function isPos(view) {
    var h1 = view.querySelector(".h1");
    return h1 && h1.textContent.trim().toLowerCase() === "kiirmüük";
  }

  // Tracks whether we are inside the Kiirmüük screen and how many draft lines
  // there were, so a newly rung-up line can be repriced without touching the
  // lines already in the draft or a price the operator typed by hand.
  var posActive = false;
  var lastLineCount = 0;

  function applyToPos() {
    var view = document.getElementById("view");
    if (!view || !isPos(view)) { posActive = false; lastLineCount = 0; return; }
    var b = active();

    // stamp barber into the eyebrow (keep the original so it never stacks)
    var eyebrow = view.querySelector(".eyebrow");
    if (eyebrow) {
      if (eyebrow.dataset.fiOrig == null) eyebrow.dataset.fiOrig = eyebrow.textContent;
      eyebrow.textContent = eyebrow.dataset.fiOrig + " · " + b.displayName;
    }

    // For each service tile: show THIS barber's price (same as the table), and
    // strike/disable treatments the barber does not perform. Products
    // (.svc.prod) are stock items, never barber services — leave them.
    var offered = offeredCategories(b);
    var serviceNames = Object.create(null); // names of real service tiles
    view.querySelectorAll(".svc:not(.prod)").forEach(function (tile) {
      var nameEl = tile.querySelector(".svcn");
      if (!nameEl) return;
      serviceNames[nameEl.textContent.trim()] = true;
      var cat = category(nameEl.textContent);

      // Keep the shop's own price so it can be put back: switching to a barber
      // who does not offer this service must not leave the previous barber's
      // price sitting on the tile.
      var svc = barberServiceForCategory(b, cat);
      var priceEl = tile.querySelector(".svcp");
      if (priceEl) {
        if (priceEl.dataset.fiShopPrice == null) priceEl.dataset.fiShopPrice = priceEl.textContent;
        priceEl.textContent = svc ? eur(priceAmount(svc.price)) : priceEl.dataset.fiShopPrice;
      }

      var unavailable = !!(cat && STRIKEABLE[cat] && !offered[cat]);
      tile.classList.toggle("fi-unavail", unavailable);
      if (tile.tagName === "BUTTON") tile.disabled = unavailable;
      tile.setAttribute("aria-disabled", unavailable ? "true" : "false");
      if (unavailable) tile.title = "Seda teenust " + b.displayName + " ei paku";
      else if (tile.title && tile.title.indexOf("ei paku") >= 0) tile.removeAttribute("title");
    });

    // Reprice a freshly added draft line to this barber's price. On first entry
    // to the screen we only take the baseline count, so existing lines and
    // hand-typed prices are never overwritten — only genuinely new lines are.
    var dlines = draftLines(view);
    var count = dlines.length;
    if (!posActive) {
      posActive = true;
    } else if (count > lastLineCount && count > 0) {
      repriceLine(dlines[count - 1], b, serviceNames);
    }
    lastLineCount = count;
  }

  // The sale lines in the draft. The tip row (Jootraha) carries the same
  // .dline class and is rendered after them, but it has no remove button and
  // only one input — counting it would make us reprice the wrong row.
  function draftLines(view) {
    return [].slice.call(view.querySelectorAll(".dline")).filter(function (d) {
      return d.querySelector(".del") && d.querySelectorAll("input").length >= 2;
    });
  }

  // Set the newest draft line's price field to the active barber's price and
  // fire an input event so the app updates its own draft state and totals.
  function repriceLine(line, b, serviceNames) {
    var nameEl = line.querySelector(".tr");
    var inputs = line.querySelectorAll("input");
    if (!nameEl || inputs.length < 2) return;
    var name = nameEl.textContent.trim();
    // Only ever touch a line that came from a service tile. A shelf product can
    // share a word with a service — "Nishmani habeme- ja vuntsihooldusõli"
    // contains "habe" — and must keep its own price.
    if (!serviceNames || !serviceNames[name]) return;
    var svc = barberServiceForCategory(b, category(name));
    if (!svc) return; // welcome drink, manual line, or an unknown service
    var amt = String(priceAmount(svc.price));
    var priceInput = inputs[1];
    if (priceInput.value !== amt) {
      priceInput.value = amt;
      priceInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ------------------------------------------------------------ boot + observe
  var obs = null;
  function startObserving() { if (obs) obs.observe(document.body, { childList: true, subtree: true }); }

  // All our DOM writes (eyebrow text, tile prices, draft-line reprice) are
  // themselves mutations, so we detach the observer while applying and reattach
  // after — otherwise the observer would loop on our own edits.
  function apply() {
    if (obs) obs.disconnect();
    // finally: never leave the observer detached — if it stopped, new lines
    // would silently keep the shop's price instead of the barber's.
    try {
      buildSelector();
      applyToPos();
    } finally {
      startObserving();
    }
  }

  function boot() {
    injectStyles();
    apply();
    // The app rebuilds #view and toggles #app on login; re-apply on any change.
    obs = new MutationObserver(apply);
    startObserving();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
