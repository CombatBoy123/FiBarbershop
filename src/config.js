// config.js — every environment variable the server reads, checked once at
// startup. A missing or placeholder value stops the boot with a message that
// says what to do, instead of surfacing later as an unrelated stack trace.

require("dotenv").config();

function fail(message) {
  throw new Error(message);
}

const DATABASE_URL = process.env.DATABASE_URL || "";

// An unset URL and an unedited placeholder both need catching. Without the
// second check pg parses "replace_this_with_..." as a hostname and the server
// dies later with "getaddrinfo ENOTFOUND base", which explains nothing.
if (!/^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
  fail(
    "DATABASE_URL puudub või on täitmata. Kopeeri .env.example failiks .env ja pane sinna " +
      "Postgresi ühendusstring, mis algab postgresql:// . Renderis leiad selle andmebaasi " +
      "lehelt (External Database URL)."
  );
}

const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET || JWT_SECRET.startsWith("replace_this")) {
  fail(
    "JWT_SECRET puudub. Kopeeri .env.example failiks .env ja pane sinna pikk juhuslik " +
      "JWT_SECRET enne serveri käivitamist."
  );
}

// The shop's own calendar. "Today" for a sale, a cash-book entry or a stock
// movement is the date on the wall in Tartu, not in UTC — at 01:00 Estonian
// time UTC still says yesterday.
const SHOP_TZ = process.env.SHOP_TZ || "Europe/Tallinn";
try {
  new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ });
} catch (e) {
  fail("SHOP_TZ ei ole tuntud ajavöönd: " + SHOP_TZ);
}

module.exports = {
  DATABASE_URL,
  JWT_SECRET,
  PORT: Number(process.env.PORT) || 4100,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ALLOW_PUBLIC_REGISTER: process.env.ALLOW_PUBLIC_REGISTER === "1",
  SHOP_TZ,
  // Where the parts of the storefront that were never saved locally live.
  SITE_URL: (process.env.SITE_URL || "https://fibarbers.ee").replace(/\/+$/, ""),
};
