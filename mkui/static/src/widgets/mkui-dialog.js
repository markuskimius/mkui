import { resolveExpr, resolveObject, evalExpr, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";

let dialogSeq = 0;

// Computed fields may feed each other; the dynamic pass repeats until no
// field value changes, giving up (and warning) after this many rounds.
export const MAX_COMPUTE_PASSES = 8;

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

    const fieldState = {};   // name → current value (what submit sends)
    const fieldEls = {};     // name → wrapper div
    const fieldInputs = {};  // name → input / select / textarea
    const fieldParts = {};   // name → { label, ro } extra DOM refs
    const resolvedAttrs = {}; // name → { required, disabled, readonly, min, max, step, pattern }
    const optionsKey = {};   // name → key of the option list last built
    const dirty = new Set(); // fields the user has typed into (compute stays off them)
    const allFields = [];
    const rowOf = new Map(); // field → the { row } item holding it
    const containers = [];   // [{ item, el }] for group headers and rows
    let computeWarned = false;
    let built = false;       // the dynamic pass waits for the whole form

    function flattenFields(items, row = null) {
      for (const item of items) {
        if (item.group != null) continue;
        if (item.row) { flattenFields(item.row, item); continue; }
        allFields.push(item);
        if (row) rowOf.set(item, row);
      }
    }
    flattenFields(spec.fields ?? []);

    // Scope for every expression the form evaluates after it opens: the
    // fields at the root (shadowing the dialog context), plus `form`, the
    // context (row, rows, selection, state, ...).
    // Number fields hold strings in `fieldState` (what submit sends); the
    // scope sees them as numbers, an empty one as NULL, so `qty * price`
    // works and `(qty ?? 0) > 0` guards the blank.
    function formScope() {
      const vals = { ...fieldState };
      for (const f of allFields) {
        if (f.type !== "number" || !f.name) continue;
        const v = vals[f.name];
        if (v === "" || v == null) { vals[f.name] = null; continue; }
        const n = Number(v);
        if (Number.isFinite(n)) vals[f.name] = n;
      }
      return { ...context, ...vals, form: vals };
    }
    // A flag key (`showWhen`, `required`, `disabled`, `readonly`) is a
    // literal boolean or an expression string.
    function truthy(cond) {
      if (cond == null) return false;
      if (typeof cond !== "string") return !!cond;
      return expr.truthy(evalExpr(cond, formScope()));
    }
    const shown = (cond) => cond == null ? true : truthy(cond);
    // `value` is the one-time default; `compute` re-evaluates on every change.
    // Either is a bare expression, or a `${...}` template when it holds one.
    function evalValue(src) {
      if (typeof src !== "string") return src ?? "";
      if (src.includes("${")) return resolveExpr(src, formScope());
      const v = evalExpr(src, formScope());
      return v == null ? "" : v;
    }
    function defaultValue(field) {
      return field.value == null ? "" : resolveExpr(field.value, formScope());
    }
    function isShown(field) {
      if (!shown(field.showWhen)) return false;
      const row = rowOf.get(field);
      return row ? shown(row.showWhen) : true;
    }

    // Write a value into a field's state and DOM; true when the state changed.
    function setFieldValue(field, v) {
      const name = field.name;
      if (!name) return false;
      const input = fieldInputs[name];
      let next;
      if (field.type === "hidden") {
        next = v;
      } else if (field.type === "readonly") {
        next = v;
        const ro = fieldParts[name]?.ro;
        if (ro) ro.textContent = v == null ? "" : String(v);
      } else if (field.type === "checkbox") {
        next = !!v;
        if (input) input.checked = next;
      } else if (field.type === "select") {
        if (input) {
          const want = v == null || v === "" ? "" : String(v);
          input.value = want !== "" ? want : (input.options?.[0]?.value ?? "");
          next = input.value;
        } else next = v == null ? "" : String(v);
      } else {
        next = v == null ? "" : String(v);
        if (input) input.value = next;
      }
      const changed = !Object.is(fieldState[name], next);
      fieldState[name] = next;
      return changed;
    }

    function renderFieldItem(field) {
      if (field.type === "hidden") {
        setFieldValue(field, defaultValue(field));
        return null;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "mkui-dialog-field";
      const parts = {};

      if (field.label != null) {
        const lbl = document.createElement("label");
        lbl.textContent = resolveExpr(field.label, formScope());
        wrapper.appendChild(lbl);
        parts.label = lbl;
      }

      const onEdit = (input, read) => () => {
        if (field.name) {
          fieldState[field.name] = read(input);
          dirty.add(field.name);
          onFieldChange(field.name);
        }
      };

      let input;
      if (field.type === "readonly") {
        const ro = document.createElement("div");
        ro.className = "mkui-dialog-readonly";
        wrapper.appendChild(ro);
        parts.ro = ro;
      } else if (field.type === "select") {
        input = document.createElement("select");
        populateSelect(input, field, extra);
        input.addEventListener("change", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      } else if (field.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.style.width = "auto";
        input.addEventListener("change", onEdit(input, (i) => i.checked));
        wrapper.appendChild(input);
      } else if (field.type === "textarea") {
        input = document.createElement("textarea");
        if (field.rows) input.rows = field.rows;
        input.addEventListener("input", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      } else {
        input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        input.addEventListener("input", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      }

      if (field.name) {
        fieldEls[field.name] = wrapper;
        fieldParts[field.name] = parts;
        if (input) fieldInputs[field.name] = input;
      }
      if (field.type === "select") syncOptions(field);
      setFieldValue(field, defaultValue(field));
      if (field.type === "select") fetchOptionsFrom(input, field, extra);

      return wrapper;
    }

    ws.registerPane(paneId, {
      title: resolveExpr(spec.title ?? "Dialog", context),
      type: "_dialog",
    });
    let currentTitle = resolveExpr(spec.title ?? "Dialog", context);

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
        hdr.textContent = resolveExpr(item.group, formScope());
        body.appendChild(hdr);
        containers.push({ item, el: hdr });
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
        containers.push({ item, el: rowDiv });
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
    footer.appendChild(status);
    // The note shares the span with submit feedback ("Sending...", errors,
    // "OK"); it is rewritten only when its own text changes.
    let lastNote;
    function syncNote() {
      if (!spec.footer?.note) return;
      const t = resolveExpr(spec.footer.note, formScope());
      if (t === lastNote) return;
      lastNote = t;
      status.textContent = t;
      status.className = "mkui-dialog-status";
    }

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

    built = true;
    onFieldChange(null);

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

    // `name` is the edited field (null at open). Service-backed options
    // re-fetch for it and for every field a compute moved along the way.
    function onFieldChange(name) {
      const before = { ...fieldState };
      applyDynamic();
      const moved = new Set(name == null ? [] : [name]);
      for (const k of Object.keys(fieldState)) if (!Object.is(before[k], fieldState[k])) moved.add(k);
      for (const k of moved) refreshDependentOptions(k);
    }

    // The dynamic pass: computed values and option lists to a fixed point,
    // then visibility, labels, attributes, title, and footer note.
    function applyDynamic() {
      if (resolved || !built) return;
      for (let pass = 0; ; pass++) {
        let changed = false;
        for (const f of allFields) {
          if (f.compute == null || !f.name || dirty.has(f.name)) continue;
          if (setFieldValue(f, evalValue(f.compute))) changed = true;
        }
        for (const f of allFields) if (syncOptions(f)) changed = true;
        if (!changed) break;
        if (pass >= MAX_COMPUTE_PASSES) {
          if (!computeWarned) {
            computeWarned = true;
            console.warn("[mkui-dialog] computed fields did not settle (a compute cycle?)");
          }
          break;
        }
      }

      for (const { item, el } of containers) {
        el.style.display = shown(item.showWhen) ? "" : "none";
        if (item.group != null) {
          const t = resolveExpr(item.group, formScope());
          if (el.textContent !== t) el.textContent = t;
        }
      }
      for (const f of allFields) {
        if (!f.name) continue;
        const el = fieldEls[f.name];
        if (!el) continue;
        el.style.display = shown(f.showWhen) ? "" : "none";
        syncAttrs(f, el);
      }

      const title = resolveExpr(spec.title ?? "Dialog", formScope());
      if (title !== currentTitle) {
        currentTitle = title;
        ws.renamePane?.(paneId, title);
      }
      syncNote();
    }

    // Static `options` with per-option `showWhen`, or an expression yielding
    // the list; the select is rebuilt only when the list differs from the
    // one it holds. True when the rebuild moved the field's value.
    function syncOptions(f) {
      if (f.type !== "select" || !f.name || f.optionsFrom || f.optionsFromColumn) return false;
      const sel = fieldInputs[f.name];
      if (!sel) return false;
      const opts = currentOptions(f);
      const key = JSON.stringify(opts.map((o) => [o.value, o.label]));
      if (optionsKey[f.name] === key) return false;
      optionsKey[f.name] = key;
      const prev = sel.value;
      sel.innerHTML = "";
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      const keep = [...sel.options].some((o) => o.value === prev);
      sel.value = keep ? prev : (sel.options[0]?.value ?? "");
      const changed = fieldState[f.name] !== sel.value;
      fieldState[f.name] = sel.value;
      return changed;
    }
    function currentOptions(f) {
      const raw = typeof f.options === "string" ? evalExpr(f.options, formScope()) : f.options;
      return normalizeOptions(raw).filter((o) => shown(o.showWhen));
    }

    function syncAttrs(f, el) {
      const scope = formScope();
      const a = {
        required: truthy(f.required),
        disabled: truthy(f.disabled),
        readonly: truthy(f.readonly),
        min: resolveExpr(f.min, scope),
        max: resolveExpr(f.max, scope),
        step: resolveExpr(f.step, scope),
        pattern: resolveExpr(f.pattern, scope),
      };
      resolvedAttrs[f.name] = a;
      const parts = fieldParts[f.name] ?? {};
      if (parts.label) {
        const t = resolveExpr(f.label, scope);
        if (parts.label.textContent !== t) parts.label.textContent = t;
      }
      const input = fieldInputs[f.name];
      if (!input) return;
      const holdsLoad = input._mkuiLoading === true;
      const plain = f.type !== "select" && f.type !== "checkbox";
      if (!holdsLoad) input.disabled = a.disabled || (!plain && a.readonly);
      if (plain) input.readOnly = a.readonly;
      if (f.placeholder != null) {
        const p = resolveExpr(f.placeholder, scope);
        if (input.placeholder !== p) input.placeholder = p;
      }
      for (const k of ["min", "max", "step"]) {
        const v = a[k];
        if (v == null || v === "") input.removeAttribute?.(k);
        else if (String(input[k]) !== String(v)) input[k] = v;
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
      dirty.clear();
      for (const f of allFields) {
        if (!f.name || f.type === "readonly" || f.type === "hidden") continue;
        setFieldValue(f, defaultValue(f));
        const el = fieldEls[f.name];
        if (el) {
          el.classList.remove("mkui-dialog-invalid");
          const err = el.querySelector(".mkui-dialog-error");
          if (err) err.remove();
        }
      }
      applyDynamic();
      const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
      firstInput?.focus();
    }

    function collectData() {
      const data = {};
      for (const f of allFields) {
        if (!f.name || f.name.startsWith("_")) continue;
        if (f.type === "readonly") continue;
        if (!isShown(f)) continue;
        data[f.name] = fieldState[f.name] ?? "";
      }
      return data;
    }

    async function submit() {
      if (resolved) return;
      if (!validate()) return;
      const data = collectData();

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
        if (!isShown(f)) continue;

        el.classList.remove("mkui-dialog-invalid");
        const existing = el.querySelector(".mkui-dialog-error");
        if (existing) existing.remove();

        const val = fieldState[f.name];
        const a = resolvedAttrs[f.name] ?? {};
        const message = () => f.invalidMessage != null ? resolveExpr(f.invalidMessage, formScope()) : null;
        let err = null;

        if (a.required && (val === "" || val == null || val === false)) {
          err = message() ?? "Required";
        } else if (a.pattern && val) {
          try {
            if (!new RegExp(a.pattern).test(String(val))) {
              err = message() ?? "Invalid format";
            }
          } catch (_) {}
        } else if (f.type === "number" && val !== "" && val != null) {
          const n = Number(val);
          if (a.min != null && a.min !== "" && n < Number(a.min)) err = message() ?? `Min: ${a.min}`;
          if (a.max != null && a.max !== "" && n > Number(a.max)) err = message() ?? `Max: ${a.max}`;
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
        applyDynamic();
        return;
      }

      selectEl.disabled = true;
      selectEl._mkuiLoading = true;
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
        selectEl._mkuiLoading = false;
        selectEl.disabled = resolvedAttrs[field.name]?.disabled ?? false;
      }
      applyDynamic();
    }
  });
}

export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => {
    if (o == null || typeof o !== "object") return { value: String(o ?? ""), label: String(o ?? "") };
    return { value: o.value ?? "", label: o.label ?? o.value ?? "", showWhen: o.showWhen };
  });
}

function populateSelect(sel, field, extra) {
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
  // Static / expression options are built by the dynamic pass (syncOptions).
}
