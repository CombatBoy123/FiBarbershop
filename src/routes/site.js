// routes/site.js — the till's own page, and what the bare address does.
//
// The server used to show a saved copy of the public shop front at "/". The
// real shop lives at fibarbers.ee, so the copy is gone and the address opens
// the till.

const path = require("path");
const express = require("express");

const PUBLIC = path.join(__dirname, "..", "..", "public");

const router = express.Router();

// 302, not 301: a browser remembers a permanent redirect for good, and "/"
// may want to become something else one day.
router.get("/", (req, res) => res.redirect(302, "/app"));

// The till. It loads only same-origin code and Google Fonts and has no inline
// <script>, so it can carry a strict Content-Security-Policy. 'unsafe-inline'
// is kept for style only, because the design uses inline style attributes.
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

// Nothing else is served here. A plain 404 rather than a redirect, so a stray
// request (an old shop-front link, a /favicon.ico) is not answered with HTML.
router.use((req, res) => res.status(404).type("text").send("Lehte ei leitud."));

module.exports = router;
