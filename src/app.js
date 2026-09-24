// app.js — the Express application: security headers, the JSON API, the
// static files and the shop front. Built by a function rather than at require
// time, so the smoke test can run the real app in-process on a spare port.
//
// Everything under /api is scoped to the signed-in account's shop: two shops
// on the same instance never see each other's books.

const path = require("path");
const express = require("express");
const cors = require("cors");

const { ALLOWED_ORIGINS } = require("./config");
const { query } = require("./db");

function createApp() {
  const app = express();

  // Don't advertise the framework.
  app.disable("x-powered-by");

  // Behind Render there is one proxy hop: trust it so req.ip is the real
  // client (the login rate limiter relies on it) and req.secure reflects the
  // TLS the browser actually used (the HSTS header below relies on it).
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    // Only pin HTTPS over a genuinely secure connection, so local http
    // testing is never locked to https by a lingering HSTS entry.
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  });

  // Liveness for Render's health check: the process is up and the database
  // answers. Deliberately says nothing else.
  app.get("/healthz", async (req, res) => {
    try {
      await query("SELECT 1");
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false });
    }
  });

  const api = express.Router();
  api.use(cors({ origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS }));
  api.use(express.json({ limit: "256kb" }));
  // Every answer here is somebody's books. Never let a shared cache keep one.
  api.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use(require("./routes/auth"));
  api.use(require("./routes/catalog"));
  api.use(require("./routes/stock"));
  api.use(require("./routes/invoices"));
  api.use(require("./routes/ledger"));
  api.use(require("./routes/staff"));
  api.use(require("./routes/barbers"));
  api.use(require("./routes/customers"));
  api.use((req, res) => res.status(404).json({ error: "Tundmatu API otspunkt." }));
  app.use("/api", api);

  // index:false and the redirect — the till's page is served by its own route
  // with its security policy; the static handler must not hand out a copy
  // without it.
  app.get("/app.html", (req, res) => res.redirect(301, "/app"));
  app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));
  app.use(require("./routes/site"));

  // Errors thrown inside a route land here. `status` is set deliberately for
  // the cases the till should show verbatim; anything else is logged and
  // answered with a generic message.
  app.use((err, req, res, next) => {
    // A malformed or oversized request body (express.json) shouldn't echo the
    // parser's internal message — return a generic 400 instead.
    if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
      return res.status(400).json({ error: "Vigane päring." });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Serveri viga. Proovi uuesti." : err.message });
  });

  return app;
}

module.exports = { createApp };
