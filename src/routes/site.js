// routes/site.js — the public shop front and the till's own page.
//
// The shop front is a saved copy of fibarbers.ee living in public/site. Its
// pages carry <base href="/site/"> so their relative assets resolve no matter
// which URL served them, and its internal links are root-absolute — so the
// original paths are mapped here rather than rewritten in the HTML.

const path = require("path");
const express = require("express");

const { SITE_URL } = require("../config");

const PUBLIC = path.join(__dirname, "..", "..", "public");
const SITE = path.join(PUBLIC, "site");

const router = express.Router();

const sitePage = (file) => (req, res) => res.sendFile(path.join(SITE, file));

router.get("/", sitePage("home.html"));
router.get("/pages/broneeri-aeg", sitePage("broneeri.html"));
router.get("/collections/all", sitePage("tooted.html"));
router.get("/pages/contact", sitePage("kontakt.html"));

// The till. It loads only same-origin code and Google Fonts and has no inline
// <script>, so it can carry a strict Content-Security-Policy — which the saved
// storefront pages cannot, hence scoping it to this route. 'unsafe-inline' is
// kept for style only, because the design uses inline style attributes.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

router.get("/app", (req, res) => {
  // Express matches /app/ here too, and under /app/ the page's relative asset
  // URLs would resolve to /app/css/... — which came back as this page.
  if (req.path !== "/app") return res.redirect(301, "/app");
  res.setHeader("Content-Security-Policy", APP_CSP);
  // The page is tiny and changes with every deploy; the scripts it loads are
  // revalidated by the static handler.
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC, "app.html"));
});

// There is only one page; anything below it goes back to it.
router.get("/app/*", (req, res) => res.redirect(301, "/app"));

// Everything the saved copy does not cover — a product page, a policy, the
// English version — lives on the real shop, so send it there rather than
// showing a page that half works. Forms on the saved pages (contact, cart,
// language) post to paths this server has no handler for; 307 keeps the
// method and body, so the post reaches the real shop instead of a 404.
router.get("*", (req, res) => res.redirect(302, SITE_URL + req.originalUrl));
router.post("*", (req, res) => res.redirect(307, SITE_URL + req.originalUrl));

module.exports = router;
