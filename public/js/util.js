// util.js — formatting and DOM helpers shared by every view.

// ------------------------------------------------------------ formatting

// Estonian money formatting: comma decimal, space before the euro sign.
export const num = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace(".", ",");
export const eur = (v) => num(v) + " €";

// Signed amount for the cash book, where the sign carries the meaning.
export const signed = (v) => (Number(v) >= 0 ? "+" : "−") + num(Math.abs(Number(v || 0)));

// Dates travel as YYYY-MM-DD and are shown as dd.MM.yyyy (or dd.MM in tables).
export function dateET(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return d + "." + m + "." + y;
}

export function dayMonth(iso) {
  if (!iso) return "";
  const [, m, d] = String(iso).slice(0, 10).split("-");
  return d + "." + m;
}

// Local calendar date, not UTC: at 01:00 Estonian time toISOString() would
// still say yesterday, which would date a sale to the wrong day.
export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

export const MONTHS = [
  "Jaanuar", "Veebruar", "Märts", "Aprill", "Mai", "Juuni",
  "Juuli", "August", "September", "Oktoober", "November", "Detsember",
];

export function monthLabel(iso) {
  const [y, m] = String(iso || todayISO()).split("-");
  return MONTHS[Number(m) - 1] + " " + y;
}

// Accepts what a till operator actually types: "12,50" as well as "12.50".
export function parseNum(v) {
  const n = Number(String(v == null ? "" : v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

// ------------------------------------------------------------------- DOM

// Minimal hyperscript. Everything here builds nodes and sets textContent, so
// a product name typed by staff can never become markup.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "hidden" || k === "selected") el[k] = Boolean(v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// The four corner crosses every panel in the design carries.
export const marks = () =>
  ["tl", "tr", "bl", "br"].map((p) => h("span", { class: "mk " + p, "aria-hidden": "true", text: "+" }));

export function panel(attrs, ...children) {
  return h("div", { class: "panel", ...(attrs || {}) }, ...marks(), ...children);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ----------------------------------------------------------------- toast

let toastTimer = null;

export function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ------------------------------------------------------------------- CSV

// Quotes every field and doubles inner quotes, so a description containing a
// comma or a quote cannot shift the columns. Excel in Estonia reads
// semicolon-separated files, and the BOM keeps ä/ö/õ/ü intact there.
export function toCSV(rows) {
  const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}

export function downloadCSV(filename, rows) {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
