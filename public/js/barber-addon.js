// barber-addon.js — self-contained barber picker for the till.
//
// A single bolt-on file: it does NOT modify any of the app's own modules.
// The only wiring it needs is one <script> tag in app.html. It injects its
// own styles, adds the barber selector to the navbar, and shows the active
// barber's price list and cut times on the Kiirmüük screen.
//
// Because it lives outside the app's modules, it cannot push a line into the
// till's draft for you (that call is internal to the app). It surfaces each
// barber's prices and times as a clear reference the operator reads while
// ringing the sale up on the existing tiles. The fully integrated version
// (click-a-tile-adds-the-line) is in git history at commit 338c35c.

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
  function formatDuration(min) {
    var m = Number(min) || 0, h = Math.floor(m / 60), r = m % 60;
    if (h === 0) return r + " min";
    return r > 0 ? h + " h " + r + " min" : h + " h";
  }
  function priceLabel(price, now) {
    now = now || new Date();
    switch (price.type) {
      case "fixed": return price.amount + " €";
      case "range": return price.min + "–" + price.max + " €";
      case "free": return "Tasuta";
      case "surcharge": return "+" + price.amount + " €";
      case "scheduled": return resolveScheduled(price, now) + " €";
      default: return "";
    }
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
    refreshPos();
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
      "#fi-bsw-pospanel .svc{cursor:default}",
      "#fi-bsw-pospanel .svc:hover{border-color:var(--line)}",
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
    nameBtn.title = "Aktiivne barber — hinnad ja ajad";
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

  // ------------------------------------------------------------ Kiirmüük panel
  // Shows the active barber's prices and cut times on the till screen, and
  // stamps the barber's name into the "Uus arve" eyebrow. Re-applied after
  // every re-render of #view (the app rebuilds that node on each action).
  function isPos(view) {
    var h1 = view.querySelector(".h1");
    return h1 && h1.textContent.trim().toLowerCase() === "kiirmüük";
  }

  function buildPosPanel(b) {
    var wrap = el("div", "panel");
    wrap.id = "fi-bsw-pospanel";
    ["tl", "tr", "bl", "br"].forEach(function (p) {
      var m = el("span", "mk " + p, "+"); m.setAttribute("aria-hidden", "true"); wrap.appendChild(m);
    });
    wrap.appendChild(el("p", "thr", "Aktiivne barber · " + b.displayName + " — hinnad ja ajad"));
    var grid = el("div", "cardgrid");
    b.services.forEach(function (s) {
      var card = el("div", "svc");
      card.appendChild(el("span", "svcn", s.name));
      card.appendChild(el("span", "svcp", priceLabel(s.price)));
      card.appendChild(el("span", "svcm", formatDuration(s.durationMin) + (s.isAddOn ? " · lisateenus" : "")));
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function refreshPos() {
    var view = document.getElementById("view");
    if (!view) return;
    var old = document.getElementById("fi-bsw-pospanel");
    if (!isPos(view)) { if (old) old.remove(); return; }

    var b = active();
    // stamp barber into the eyebrow (store the original once so it doesn't stack)
    var eyebrow = view.querySelector(".eyebrow");
    if (eyebrow) {
      if (eyebrow.dataset.fiOrig == null) eyebrow.dataset.fiOrig = eyebrow.textContent;
      eyebrow.textContent = eyebrow.dataset.fiOrig + " · " + b.displayName;
    }

    var panel = buildPosPanel(b);
    if (old) { old.replaceWith(panel); return; }
    var cols = view.querySelector(".cols");
    if (cols) view.insertBefore(panel, cols);
    else view.appendChild(panel);
  }

  // ------------------------------------------------------------ boot + observe
  function boot() {
    injectStyles();
    buildSelector();
    refreshPos();

    // The app rebuilds #view and toggles #app on login; re-apply on any change.
    var obs = new MutationObserver(function () {
      buildSelector();
      // guard against reacting to our own insertion: only act when our panel
      // is missing or the eyebrow needs (re)stamping.
      var view = document.getElementById("view");
      if (!view) return;
      var needPanel = isPos(view) && !document.getElementById("fi-bsw-pospanel");
      if (needPanel) refreshPos();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
