// api.js — the only module that talks to the server.
// Every other file goes through these functions, so swapping transport or
// adding a header is a one-file change.

const TOKEN_KEY = "fi_token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null; // private mode with storage blocked
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* session-only login is still better than refusing to work */
  }
}

// Thrown for any non-2xx response. `status` lets callers treat 401 (session
// expired) differently from 409 (out of stock), which the till shows verbatim.
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError("Ühendus serveriga puudub. Kontrolli internetti.", 0);
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    if (res.ok) return null;
  }

  if (!res.ok) {
    throw new ApiError((data && data.error) || "Midagi läks valesti.", res.status);
  }
  return data;
}

const get = (p) => request("GET", p);
const post = (p, b) => request("POST", p, b);
const put = (p, b) => request("PUT", p, b);
const del = (p) => request("DELETE", p);

export const api = {
  // auth
  login: (email, password) => post("/api/login", { email, password }),
  me: () => get("/api/me"),

  // the whole till in one call
  bootstrap: () => get("/api/bootstrap"),

  // settings, price list, products
  saveSettings: (patch) => put("/api/settings", patch),
  addService: (s) => post("/api/services", s),
  updateService: (id, patch) => put("/api/services/" + id, patch),
  removeService: (id) => del("/api/services/" + id),
  addProduct: (p) => post("/api/products", p),
  updateProduct: (id, patch) => put("/api/products/" + id, patch),
  removeProduct: (id) => del("/api/products/" + id),
  // set stock outright; the server books the difference as a movement
  setStock: (id, qty) => put("/api/products/" + id + "/stock", { qty }),

  // a sale writes the invoice, the cash-book entry and the stock movements
  // together; the response carries the refreshed state so nothing goes stale
  createSale: (sale) => post("/api/sales", sale),
  // voids an invoice: number kept, cash-book entry and stock movements undone
  cancelInvoice: (id, reason) => post("/api/invoices/" + id + "/cancel", { reason }),

  // kassaraamat
  addLedger: (entry) => post("/api/ledger", entry),
  removeLedger: (id) => del("/api/ledger/" + id),

  // ladu
  addMovement: (m) => post("/api/stock-movements", m),
  removeMovement: (id) => del("/api/stock-movements/" + id),
};
