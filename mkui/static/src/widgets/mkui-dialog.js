import { resolveExpr, resolveObject, evalExpr, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";

let dialogSeq = 0;

export function openDialog(spec, context, app, extra = {}) {
  return new Promise((resolve) => {
    const ws = app._element?.workspace ?? app._element?._workspace;
    if (!ws) {
      console.error("[mkui-dialog] no workspace found");
      resolve(null);
      return;
    }

    const paneId = `_dialog-${++dialogSeq}`;
    let resolved = false;

    const fieldState = {};
    const fieldEls = {};
    const fieldInputs = {};
    const allFields = [];

    function flattenFields(items) {
      for (const item of items) {
        if (item.group != null) continue;
        if (item.row) { flattenFields(item.row); continue; }
        allFields.push(item);
      }
    }
    flattenFields(spec.fields ?? []);

    function renderFieldItem(field) {
      if (field.type === "hidden") {
        const val = resolveExpr(field.value ?? "", context);
        fieldState[field.name] = val;
        return null;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "mkui-dialog-field";

      if (field.label) {
        const lbl = document.createElement("label");
        lbl.textContent = field.label;
        wrapper.appendChild(lbl);
      }

      const rv = resolveExpr(field.value ?? "", context);

      let input;
      if (field.type === "readonly") {
        const ro = document.createElement("div");
        ro.className = "mkui-dialog-readonly";
        ro.textContent = rv;
        wrapper.appendChild(ro);
        if (field.name) fieldState[field.name] = rv;
      } else if (field.type === "select") {
        input = document.createElement("select");
        populateSelect(input, field, context, extra);
        if (rv !== "") input.value = String(rv);
        if (field.name) fieldState[field.name] = input.value;
        input.addEventListener("change", () => {
          if (field.name) fieldState[field.name] = input.value;
          onFieldChange(field.name);
        });
        wrapper.appendChild(input);
        fetchOptionsFrom(input, field, extra);
      } else if (field.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!rv;
        input.style.width = "auto";
        if (field.name) fieldState[field.name] = input.checked;
        input.addEventListener("change", () => {
          if (field.name) fieldState[field.name] = input.checked;
          onFieldChange(field.name);
        });
        wrapper.appendChild(input);
      } else if (field.type === "textarea") {
        input = document.createElement("textarea");
        if (field.rows) input.rows = field.rows;
        if (field.placeholder) input.placeholder = field.placeholder;
        input.value = rv == null ? "" : String(rv);
        if (field.name) fieldState[field.name] = input.value;
        input.addEventListener("input", () => {
          if (field.name) fieldState[field.name] = input.value;
        });
        wrapper.appendChild(input);
      } else {
        input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.min != null) input.min = field.min;
        if (field.max != null) input.max = field.max;
        if (field.step != null) input.step = field.step;
        input.value = rv == null ? "" : String(rv);
        if (field.name) fieldState[field.name] = input.value;
        input.addEventListener("input", () => {
          if (field.name) fieldState[field.name] = input.value;
          onFieldChange(field.name);
        });
        wrapper.appendChild(input);
      }

      if (field.disabled) {
        if (input) input.disabled = true;
      }

      if (field.name) {
        fieldEls[field.name] = wrapper;
        if (input) fieldInputs[field.name] = input;
      }

      return wrapper;
    }

    ws.registerPane(paneId, {
      title: resolveExpr(spec.title ?? "Dialog", context),
      type: "_dialog",
    });

    const widthPx = spec.width ?? 400;
    const wsRect = ws.getBoundingClientRect();
    const wFrac = Math.min(widthPx / wsRect.width, 0.9);
    const hFrac = Math.min(0.6, 400 / wsRect.height);
    const xFrac = Math.max(0, (1 - wFrac) / 2);
    const yFrac = Math.max(0, (1 - hFrac) / 2);

    let pinned = false;
    function makePinBtn() {
      const btn = document.createElement("div");
      btn.className = "mkui-frame-btn mkui-dialog-pin" + (pinned ? " mkui-dialog-pin-active" : "");
      btn.appendChild(icon("pin"));
      btn.title = pinned ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
      btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pinned = !pinned;
        btn.classList.toggle("mkui-dialog-pin-active", pinned);
        btn.title = pinned ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
      });
      return btn;
    }

    const frameId = ws.addFrame({
      x: xFrac, y: yFrac, w: wFrac, h: hFrac,
      stayOnTop: true,
      noDock: true,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });

    const frameEl = ws._frameEls.get(frameId);
    if (frameEl) {
      frameEl._extraControls = () => [makePinBtn()];
      frameEl._renderInternal();
    }

    const paneEl = ws._paneEls.get(paneId);
    if (!paneEl) { resolve(null); return; }
    const host = paneEl.contentEl;
    host.textContent = "";

    const container = document.createElement("div");
    container.className = "mkui-dialog-content";

    const body = document.createElement("div");
    body.className = "mkui-dialog-body";

    for (const item of spec.fields ?? []) {
      if (item.group != null) {
        const hdr = document.createElement("div");
        hdr.className = "mkui-dialog-group";
        hdr.textContent = item.group;
        body.appendChild(hdr);
        continue;
      }

      if (item.row) {
        const rowDiv = document.createElement("div");
        rowDiv.className = "mkui-dialog-row";
        for (const f of item.row) {
          const el = renderFieldItem(f);
          if (el) {
            if (f.width) el.style.flex = `1 1 ${f.width * 100}%`;
            rowDiv.appendChild(el);
          }
        }
        body.appendChild(rowDiv);
        continue;
      }

      const el = renderFieldItem(item);
      if (el) body.appendChild(el);
    }

    container.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "mkui-dialog-footer";

    const status = document.createElement("span");
    status.className = "mkui-dialog-status";
    if (spec.footer?.note) {
      status.textContent = resolveExpr(spec.footer.note, context);
    }
    footer.appendChild(status);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mkui-btn";
    cancelBtn.textContent = spec.cancel?.label ?? "Cancel";
    cancelBtn.addEventListener("click", close);

    const submitBtn = document.createElement("button");
    submitBtn.className = "mkui-btn mkui-btn-primary";
    submitBtn.textContent = spec.submit?.label ?? "OK";
    submitBtn.addEventListener("click", submit);

    footer.append(cancelBtn, submitBtn);
    container.appendChild(footer);

    host.appendChild(container);

    const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
    firstInput?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") submit();
    };
    host.addEventListener("keydown", onKey);

    paneEl.addEventListener("mkui-pane-close", () => {
      if (!resolved) {
        resolved = true;
        host.removeEventListener("keydown", onKey);
        queueMicrotask(() => ws.unregisterPane(paneId));
        resolve(null);
      }
    });

    applyShowWhen();

    // The initial height is a guess; if the body has to scroll, grow the
    // frame so the whole form and footer are visible, capped at 90% of the
    // workspace, and re-center vertically.
    const bodyOverflow = body.scrollHeight - body.clientHeight;
    if (bodyOverflow > 0) {
      const fspec = ws._frames.find((f) => f.id === frameId);
      if (fspec && wsRect.height > 0) {
        const curPx = frameEl?.offsetHeight ?? hFrac * wsRect.height;
        const newFrac = Math.min((curPx + bodyOverflow) / wsRect.height, 0.9);
        fspec.h = newFrac;
        fspec.y = Math.max(0, (1 - newFrac) / 2);
        ws._layoutFrames();
      }
    }

    function onFieldChange(name) {
      applyShowWhen();
      refreshDependentOptions(name);
    }

    // `showWhen = "<expr>"` — scope: the form's fields at the root (shadowing
    // the dialog context), plus `form`, the context (row, rows, selection,
    // state, ...). A literal boolean works too.
    function formScope() {
      return { ...context, ...fieldState, form: fieldState };
    }
    function shown(cond) {
      if (typeof cond === "boolean") return cond;
      return expr.truthy(evalExpr(String(cond), formScope()));
    }

    function applyShowWhen() {
      for (const f of allFields) {
        if (f.showWhen == null || !f.name) continue;
        const el = fieldEls[f.name];
        if (!el) continue;
        el.style.display = shown(f.showWhen) ? "" : "none";
      }

      for (const f of allFields) {
        if (f.type !== "select" || !f.name) continue;
        const sel = fieldInputs[f.name];
        if (!sel) continue;
        const opts = normalizeOptions(f.options);
        if (!opts.some((o) => o.showWhen)) continue;
        const prev = sel.value;
        sel.innerHTML = "";
        for (const o of opts) {
          if (o.showWhen != null && !shown(o.showWhen)) continue;
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
        else { sel.value = sel.options[0]?.value ?? ""; }
        if (f.name) fieldState[f.name] = sel.value;
      }
    }

    function refreshDependentOptions(changedField) {
      for (const f of allFields) {
        if (!f.optionsFrom || !f.name) continue;
        const paramStr = JSON.stringify(f.optionsFrom.params ?? {});
        if (!paramStr.includes("${field." + changedField + "}")) continue;
        fetchOptionsFrom(fieldInputs[f.name], f, extra);
      }
    }

    function cleanup() {
      host.removeEventListener("keydown", onKey);
      ws.unregisterPane(paneId);
    }

    function close() {
      if (resolved) return;
      resolved = true;
      ws.closeFrame(frameId);
      cleanup();
      resolve(null);
    }

    function resetForm() {
      for (const f of allFields) {
        if (!f.name || f.type === "readonly" || f.type === "hidden") continue;
        const rv = resolveExpr(f.value ?? "", context);
        const input = fieldInputs[f.name];
        if (f.type === "checkbox") {
          if (input) input.checked = !!rv;
          fieldState[f.name] = !!rv;
        } else if (f.type === "select") {
          if (input) input.value = rv !== "" ? String(rv) : (input.options[0]?.value ?? "");
          fieldState[f.name] = input?.value ?? "";
        } else {
          if (input) input.value = rv == null ? "" : String(rv);
          fieldState[f.name] = input?.value ?? "";
        }
        const el = fieldEls[f.name];
        if (el) {
          el.classList.remove("mkui-dialog-invalid");
          const err = el.querySelector(".mkui-dialog-error");
          if (err) err.remove();
        }
      }
      applyShowWhen();
      const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
      firstInput?.focus();
    }

    async function submit() {
      if (resolved) return;
      if (!validate()) return;
      const data = {};
      for (const f of allFields) {
        if (!f.name || f.name.startsWith("_")) continue;
        if (f.type === "readonly") continue;
        if (f.showWhen != null && !shown(f.showWhen)) continue;
        data[f.name] = fieldState[f.name] ?? "";
      }

      const client = extra.client;
      const svc = spec.submit?.service;
      if (svc && client?.send) {
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        status.textContent = "Sending...";
        status.className = "mkui-dialog-status";
        try {
          const sends = [];
          if (spec.submitPerRow && context.rows?.length > 0) {
            for (const row of context.rows) {
              const rowCtx = { ...context, row };
              const perRowData = resolveObject(spec.rowData ?? {}, rowCtx);
              sends.push(client.send(svc, { ...data, ...perRowData }, { op: spec.submit.op }));
            }
          } else {
            sends.push(client.send(svc, data, { op: spec.submit.op }));
          }
          const timeout = spec.submit?.timeout ?? 5000;
          const withTimeout = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out")), timeout)),
          ]);
          const results = await withTimeout(Promise.all(sends));
          const err = results.find(r => r.type === "error");
          if (err) {
            status.textContent = err.message || err.data?.message || "Transaction failed";
            status.className = "mkui-dialog-status mkui-dialog-status-error";
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
          }
          if (pinned) {
            status.textContent = "OK";
            status.className = "mkui-dialog-status";
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            resetForm();
          } else {
            resolved = true;
            ws.closeFrame(frameId);
            cleanup();
            resolve(data);
          }
        } catch (e) {
          status.textContent = e.message || "Transaction failed";
          status.className = "mkui-dialog-status mkui-dialog-status-error";
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      } else {
        if (pinned) {
          resetForm();
        } else {
          resolved = true;
          ws.closeFrame(frameId);
          cleanup();
          resolve(data);
        }
      }
    }

    function validate() {
      let ok = true;
      for (const f of allFields) {
        if (!f.name) continue;
        const el = fieldEls[f.name];
        if (!el) continue;
        if (el.style.display === "none") continue;

        el.classList.remove("mkui-dialog-invalid");
        const existing = el.querySelector(".mkui-dialog-error");
        if (existing) existing.remove();

        const val = fieldState[f.name];
        let err = null;

        if (f.required && (val === "" || val == null)) {
          err = f.invalidMessage ?? "Required";
        } else if (f.pattern && val) {
          try {
            if (!new RegExp(f.pattern).test(String(val))) {
              err = f.invalidMessage ?? "Invalid format";
            }
          } catch (_) {}
        } else if (f.type === "number" && val !== "" && val != null) {
          const n = Number(val);
          if (f.min != null && n < f.min) err = f.invalidMessage ?? `Min: ${f.min}`;
          if (f.max != null && n > f.max) err = f.invalidMessage ?? `Max: ${f.max}`;
        }

        if (err) {
          ok = false;
          el.classList.add("mkui-dialog-invalid");
          const msg = document.createElement("div");
          msg.className = "mkui-dialog-error";
          msg.textContent = err;
          el.appendChild(msg);
        }
      }
      return ok;
    }

    async function fetchOptionsFrom(selectEl, field, extra) {
      if (!field.optionsFrom || !selectEl) return;
      const client = extra.client;
      if (!client?.request) return;

      const params = resolveObject(field.optionsFrom.params ?? {}, { ...context, field: fieldState });
      const hasUnresolved = Object.values(params).some((v) => v === "");
      if (hasUnresolved) {
        selectEl.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "—";
        selectEl.appendChild(opt);
        if (field.name) fieldState[field.name] = "";
        return;
      }

      selectEl.disabled = true;
      try {
        const resp = await client.request(field.optionsFrom.service, params);
        const rows = Array.isArray(resp) ? resp : resp?.rows ?? [];
        selectEl.innerHTML = "";
        const emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "—";
        selectEl.appendChild(emptyOpt);
        for (const r of rows) {
          const opt = document.createElement("option");
          opt.value = r[field.optionsFrom.value] ?? "";
          opt.textContent = r[field.optionsFrom.label] ?? opt.value;
          selectEl.appendChild(opt);
        }
        selectEl.value = "";
        if (field.name) fieldState[field.name] = "";
      } catch (e) {
        console.error("[mkui-dialog] optionsFrom error:", e);
      } finally {
        selectEl.disabled = false;
      }
    }
  });
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => {
    if (typeof o === "string") return { value: o, label: o };
    return { value: o.value ?? "", label: o.label ?? o.value ?? "", showWhen: o.showWhen };
  });
}

function populateSelect(sel, field, context, extra) {
  if (field.optionsFromColumn && extra.tableRows) {
    const col = field.optionsFromColumn;
    const vals = new Set();
    for (const row of extra.tableRows.values()) {
      const v = row[col];
      if (v != null) vals.add(String(v));
    }
    const sorted = [...vals].sort();
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "—";
    sel.appendChild(emptyOpt);
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    return;
  }

  if (field.optionsFrom) return;

  const opts = normalizeOptions(field.options);
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}
