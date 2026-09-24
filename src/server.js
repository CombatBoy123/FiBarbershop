// server.js — start the back office: bring the database schema up to date,
// then listen. The application itself is built in app.js.

const { PORT } = require("./config");
const { pool } = require("./db");
const { ready } = require("./migrations");
const { createApp } = require("./app");

async function main() {
  // Nothing is served until the schema is current. A failed migration stops
  // the boot here, with the step that failed named in the error.
  await ready();

  const server = createApp().listen(PORT, () => {
    console.log("Fi Barbershop server kuulab pordil " + PORT + " — http://localhost:" + PORT + "/app");
  });

  // Render sends SIGTERM on every deploy. Finish the requests in flight and
  // return the database connections instead of dropping both mid-sale.
  const stop = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
