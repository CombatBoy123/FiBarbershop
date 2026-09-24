// dialog.js — the one modal the till uses for every question it has to ask.
//
// Replaces window.prompt() and window.confirm(). Those could ask one thing at
// a time — cancelling an invoice took two prompts in a row, and closing the
// second one silently threw the first answer away — and they cannot say which
// button is the dangerous one.

import { h } from "./util.js";

// ask({ title, message, fields, confirm, danger }) resolves to the typed
// values keyed by field name, or null when the person backs out.
//
// A field is { name, label, type, value, placeholder, required, match,
// options, autocomplete }. `match` is a string the input must equal exactly —
// how "type the invoice number to confirm" is expressed.
export function ask({ title, message = "", fields = [], confirm = "Kinnita", cancel = "Loobu", danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById("app") || document.body;
    const err = h("p", { class: "err", role: "alert" });

    const inputs = fields.map((f) => {
      const input = f.options
        ? h("select", { class: "inp", name: f.name },
            ...f.options.map((o) => h("option", { value: o.value, selected: String(o.value) === String(f.value) }, o.label)))
        : h("input", {
            class: "inp", name: f.name, type: f.type || "text",
            value: f.value == null ? "" : String(f.value),
            placeholder: f.placeholder || "", autocomplete: f.autocomplete || "off",
            maxlength: f.maxlength || null,
          });
      return { f, input };
    });

    const form = h("form", { class: "dlgform", method: "dialog", novalidate: "novalidate" },
      h("p", { class: "eyebrow", style: "margin:0", text: danger ? "Kinnita toiming" : "Küsimus" }),
      h("h2", { class: "dlgtitle", text: title }),
      message
        ? h("div", { class: "dlgmsg" }, ...String(message).split("\n\n").map((p) => h("p", { text: p })))
        : null,
      ...inputs.map(({ f, input }) => h("label", { class: "fld" }, h("span", { class: "lab", text: f.label }), input)),
      err,
      h("div", { class: "dlgacts" },
        h("button", { class: "btng", type: "button", value: "cancel", onclick: () => close(null) }, cancel),
        h("button", { class: danger ? "btnp danger" : "btnp", type: "submit", value: "ok" }, confirm)
      )
    );

    const dlg = h("dialog", { class: "dlg" }, form);
    let done = false;

    function close(result) {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(result);
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = {};
      for (const { f, input } of inputs) {
        const v = f.type === "password" ? input.value : input.value.trim();
        if (f.required && !v) {
          err.textContent = f.label + " on kohustuslik.";
          input.focus();
          return;
        }
        if (f.match !== undefined && v !== String(f.match)) {
          err.textContent = f.label + ": ei klapi.";
          input.focus();
          return;
        }
        if (f.minLength && v.length < f.minLength) {
          err.textContent = f.label + ": vähemalt " + f.minLength + " tähemärki.";
          input.focus();
          return;
        }
        values[f.name] = v;
      }
      close(values);
    });

    // A complaint about the last attempt goes away as soon as it is corrected.
    form.addEventListener("input", () => (err.textContent = ""));

    // Escape and the backdrop both mean "no".
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(null);
    });

    host.append(dlg);
    dlg.showModal();
    const first = inputs[0] ? inputs[0].input : form.querySelector("button[type=submit]");
    if (first) first.focus();
  });
}

// A yes/no question. Resolves to true or false.
export async function confirmAsk(title, message, { confirm = "Jah", danger = false } = {}) {
  return (await ask({ title, message, confirm, danger })) !== null;
}
