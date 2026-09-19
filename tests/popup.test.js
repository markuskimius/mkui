// Run with: node --test tests/popup.test.js
//
// Message boxes from config and from JS: the specs lib/dialogs.js builds
// for `dialog.alert` / `dialog.confirm` / `dialog.about`, `App.dialog` /
// `App.alert` / `App.confirm` over them, and the menubar's `confirm` key.
// What the dialog does with such a spec is tests/dialog.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get: () => undefined, define: () => {} };

const { messageArgs, alertSpec, confirmSpec, confirmOf, confirmed, aboutSpec, needsClient,
  suppressSpec, suppressedAnswer, storeSuppressed, readSuppressed, resetSuppressed, resetMessage, SUPPRESS_PREFIX } =
  await import("../mkui/static/src/lib/dialogs.js");
const { App, VERSION } = await import("../mkui/static/src/core.js");
const { normalizeButtons } = await import("../mkui/static/src/widgets/mkui-dialog.js");

/* ── A DOM just deep enough for a message box ────────────────────────── */

function el(tag) {
  const e = {
    tagName: String(tag).toUpperCase(), className: "", textContent: "", style: {},
    _ch: [], _ev: {}, _attrs: {},
    append(...ns) { for (const n of ns) e.appendChild(n); },
    appendChild(n) { e._ch.push(n); return n; },
    setAttribute(k, v) { e._attrs[k] = v; },
    addEventListener(name, fn) { (e._ev[name] ??= []).push(fn); },
    removeEventListener() {},
    fire(name, ev = {}) { for (const fn of e._ev[name] ?? []) fn(ev); },
    querySelector() { return null; },
    focus() {},
    get scrollHeight() { return 0; },
    get clientHeight() { return 0; },
  };
  return e;
}
globalThis.document = { createElement: el, createElementNS: (_ns, tag) => el(tag) };

// An app whose workspace records the dialogs opened on it.
function makeApp(config = {}) {
  const app = new App(config);
  const opened = [];
  const ws = {
    _frames: [], _frameEls: new Map(), _paneEls: new Map(),
    registerPane(id, spec) { opened.push({ id, title: spec.title }); },
    unregisterPane() {}, renamePane() {}, closeFrame() {}, _layoutFrames() {},
    addFrame(spec) {
      const id = `f${this._frames.length + 1}`;
      this._frames.push({ id, ...spec });
      this._frameEls.set(id, { offsetHeight: 0, _renderInternal() {} });
      const pane = { contentEl: el("div"), addEventListener() {}, setAttribute() {} };
      this._paneEls.set(spec.layout.children[0], pane);
      opened[opened.length - 1].pane = pane;
      return id;
    },
    getBoundingClientRect() { return { width: 1000, height: 800 }; },
  };
  app._element = { workspace: ws };
  return { app, opened };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const find = (n, pred) => pred(n) ? n : n._ch.map((c) => find(c, pred)).find(Boolean);
const buttonOf = (d, label) => find(d.pane.contentEl, (n) => n.tagName === "BUTTON" && n.textContent === label);
const textOf = (d, cls) => find(d.pane.contentEl, (n) => n.className === cls)?.textContent;

// What an About spec's facts come to against a state, as the dialog would
// show them: resolved, trimmed, blank lines dropped.
const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");
const factsOf = (spec, state) => spec.facts
  .map((f) => [f.label, String(resolveExpr(f.value, { state }) ?? "").trim()])
  .filter(([, v]) => v !== "");

/* ── The specs ───────────────────────────────────────────────────────── */

test("messageArgs: a string or a list is the message", () => {
  assert.deepEqual(messageArgs("hi"), { message: "hi" });
  assert.deepEqual(messageArgs(["a", "b"]), { message: ["a", "b"] });
  assert.deepEqual(messageArgs({ message: "m", kind: "warn" }), { message: "m", kind: "warn" });
  assert.deepEqual(messageArgs(null), {});
  assert.deepEqual(messageArgs(7), {});
});

test("alertSpec: one OK button that is also the way out", () => {
  const s = alertSpec("Saved.");
  assert.equal(s.message, "Saved.");
  assert.equal(s.kind, "info");
  assert.equal(s.title, "Message");
  const b = normalizeButtons(s);
  assert.deepEqual(b.map((x) => [x.id, x.cancel, x.default, x.kind]), [["ok", true, true, "primary"]]);
  const t = alertSpec({ message: "m", title: "T", kind: "success", ok: "Got it", width: 300, links: [{ href: "/x" }] });
  assert.deepEqual([t.title, t.kind, t.width, t.buttons[0].label, t.links.length], ["T", "success", 300, "Got it", 1]);
});

test("confirmSpec: Cancel and OK, `then` riding OK, danger defaulting to Cancel", () => {
  const s = confirmSpec({ message: "Reset?", then: { action: "layout.reset" } });
  assert.equal(s.kind, "question");
  const b = normalizeButtons(s);
  assert.deepEqual(b.map((x) => [x.id, x.cancel, x.default, x.kind]), [["cancel", true, false, "plain"], ["ok", false, true, "primary"]]);
  assert.deepEqual([b[1].action, b[1].args], ["layout.reset", null]);

  const d = normalizeButtons(confirmSpec({ message: "Delete?", kind: "danger", ok: "Delete", cancel: "Keep" }));
  assert.deepEqual(d.map((x) => [x.label, x.default, x.kind]), [["Keep", true, "plain"], ["Delete", false, "danger"]]);
});

test("confirmOf: a menu item's confirm, titled by the item", () => {
  assert.equal(confirmOf({ label: "Quit" }), null);
  assert.equal(confirmOf({ label: "Quit", confirm: false }), null);
  const s = confirmOf({ label: "Reset layout", confirm: "Discard this arrangement?" });
  assert.deepEqual([s.title, s.message, s.kind], ["Reset layout", "Discard this arrangement?", "question"]);
  assert.equal(confirmOf({ label: "Reset…", confirm: "?" }).title, "Reset");
  assert.equal(confirmOf({ label: "Reset...", confirm: "?" }).title, "Reset");
  const t = confirmOf({ label: "Log out", confirm: { message: "Sure?", title: "Leaving", kind: "warn", then: { action: "x" } } });
  assert.deepEqual([t.title, t.kind, t.buttons[1].action], ["Leaving", "warn", undefined], "the item's own action is what follows");
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try { assert.equal(confirmOf({ label: "x", confirm: 3 }), null); } finally { console.warn = warn; }
  assert.equal(warned, 1);
});

test("aboutSpec: a bare config still makes an About box", () => {
  const s = aboutSpec({}, { version: "9.9.9" });
  assert.equal(s.title, "About mkui");
  assert.equal(s.heading, "mkui");
  assert.deepEqual(s.message, []);
  assert.equal(s.kind, "info");
  assert.deepEqual(factsOf(s, {}), [["mkui", "9.9.9"]]);
  assert.equal(s.modal, undefined, "About is not modal");
  assert.deepEqual(normalizeButtons(s).map((b) => [b.id, !!b.copy, b.cancel, b.default]), [["copy", true, false, false], ["ok", false, true, true]]);
});

test("aboutSpec: the app block, the server it reached, who is logged in", () => {
  const config = {
    app: { title: "Orders", version: "2.4.0", description: "Order blotter.", copyright: "© 2026 Acme", icon: "/logo.svg",
      links: [{ label: "Docs", href: "https://acme.test/docs" }] },
    mkio: { url: "/ws" },
  };
  const state = { mkio: { connected: true, reason: null, server: { name: "orders", version: "2.4.0", mkio: "1.2.0" } },
    auth: { authenticated: true, user: "ann", role: "admin" } };
  const s = aboutSpec(config, { version: "1.8.0" });
  assert.deepEqual([s.title, s.heading, s.image, s.kind], ["About Orders", "Orders 2.4.0", "/logo.svg", undefined]);
  assert.deepEqual(s.message, ["Order blotter.", "© 2026 Acme"]);
  // The facts are templates over `state`, so an open box follows it.
  assert.deepEqual(factsOf(s, state), [
    ["Server", "orders 2.4.0"], ["Connection", "Connected"], ["User", "ann (admin)"], ["mkui", "1.8.0"], ["mkio", "1.2.0"],
  ]);
  assert.equal(s.links[0].label, "Docs");
  const conn = (mkio) => Object.fromEntries(factsOf(s, { mkio })).Connection;
  assert.equal(conn({ connected: false }), "Disconnected");
  assert.equal(conn({ connected: true, reason: "version" }), "Incompatible (version)");
  assert.deepEqual(factsOf(s, { auth: { authenticated: true, user: "bob", role: "" } }).find((f) => f[0] === "User"), ["User", "bob"]);
  assert.deepEqual(factsOf(s, { mkio: { server: { name: "orders" } } })[0], ["Server", "orders"], "a half-known line is trimmed");
});

test("aboutSpec: app.about overrides, adds facts, drops the built-in ones", () => {
  const s = aboutSpec({ app: { title: "X", about: { title: "About", heading: "X Pro", message: "Hand-written.",
    facts: [{ label: "Build", value: "abc123" }], builtins: false, links: [], width: 500 } } }, { version: "1" });
  assert.deepEqual([s.title, s.heading, s.message, s.width], ["About", "X Pro", "Hand-written.", 500]);
  assert.deepEqual(s.facts, [{ label: "Build", value: "abc123" }]);
});

test("aboutSpec: a builtins list picks the built-in lines and orders them", () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const config = (builtins) => ({ app: { title: "X", about: { facts: [{ label: "Build", value: "abc123" }], builtins } }, mkio: { url: "auto" } });
    const labels = (builtins) => aboutSpec(config(builtins), { version: "1.9.0" }).facts.map((f) => f.label);
    const all = ["Build", "Server", "Connection", "User", "mkui", "mkio"];
    assert.deepEqual(labels(undefined), all, "no key: every line, mkui's version ahead of mkio's");
    assert.deepEqual(labels(true), all, "true is the default spelled out");
    assert.deepEqual(labels(["server", "mkui", "mkio"]), ["Build", "Server", "mkui", "mkio"], "the app's own lines still lead");
    assert.deepEqual(labels(["mkio", "server"]), ["Build", "mkio", "Server"], "the list's order, not the default's");
    assert.deepEqual(labels([]), ["Build"], "an empty list is `false`");
    assert.deepEqual(labels(false), ["Build"]);
    assert.deepEqual(warned, [], "nothing to warn about so far");
    assert.deepEqual(labels(["server", "nonesuch", "toString"]), ["Build", "Server"], "an unknown name is dropped, an inherited one included");
    assert.equal(warned.length, 2);
    assert.match(warned[0], /app\.about\.builtins.*nonesuch/);
  } finally {
    console.warn = warn;
  }
  // A picked line is the same template the default box shows.
  const s = aboutSpec({ app: { about: { builtins: ["mkui", "server"] } } }, { version: "1.9.0" });
  assert.deepEqual(factsOf(s, { mkio: { server: { name: "orders", version: "2.4.0" } } }), [["mkui", "1.9.0"], ["Server", "orders 2.4.0"]]);
});

test("needsClient: a submit service or an optionsFrom anywhere in the fields", () => {
  assert.equal(needsClient({ message: "x" }), false);
  assert.equal(needsClient({ submit: { service: "orders" } }), true);
  assert.equal(needsClient({ fields: [{ row: [{ name: "a" }, { name: "b", optionsFrom: { service: "s" } }] }] }), true);
  assert.equal(needsClient({ fields: [{ group: "G", fields: [{ name: "b", optionsFrom: { service: "s" } }] }] }), true);
  assert.equal(needsClient({ fields: [{ name: "a" }, { group: "G" }] }), false);
});

test("confirmSpec: modal unless it says otherwise; arm and enable ride OK; the rest passes through", () => {
  const s = confirmSpec({ message: "Delete ${row.name}?", kind: "danger", ok: "Delete", arm: 2, enable: "typed == row.name",
    details: "rows…", suppress: "del", id: "del-confirm", timeout: 30, fields: [{ name: "typed" }] });
  assert.equal(s.modal, true);
  assert.deepEqual([s.details, s.suppress, s.id, s.timeout, s.fields.length], ["rows…", "del", "del-confirm", 30, 1]);
  assert.deepEqual([s.buttons[1].arm, s.buttons[1].enable, s.buttons[0].arm], [2, "typed == row.name", undefined]);
  const submit = { service: "orders", op: "roll", data: { desk: "fx" } };
  assert.deepEqual(confirmSpec({ message: "m", submit }).buttons[1].submit, submit, "the answer a server asked for rides OK");
  assert.equal(confirmSpec({ message: "m", submit: "orders" }).buttons[1].submit, undefined);
  assert.equal(needsClient(confirmSpec({ message: "m", submit })), true);
  assert.equal(confirmSpec({ message: "m", modal: false }).modal, false);
  assert.equal(alertSpec("m").modal, undefined, "a notice is not modal");
  assert.equal(alertSpec({ message: "m", modal: true, timeout: 5 }).timeout, 5);
});

test("suppressSpec and the storage behind it", () => {
  const two = [{ id: "cancel", cancel: true }, { id: "ok" }, { id: "copy", copy: true }];
  assert.equal(suppressSpec({ suppress: "k" }, null), null, "only a box with buttons");
  assert.equal(suppressSpec({}, two), null);
  const s = suppressSpec({ suppress: "k" }, two);
  assert.deepEqual([s.key, s.label], ["k", "Don't ask again"]);
  assert.deepEqual(two.map(s.remembers), [false, true, false]);
  assert.equal(suppressSpec({ suppress: { key: "k", label: "Stop" } }, two).label, "Stop");

  const store = new Map();
  const storage = { get length() { return store.size; }, key: (i) => [...store.keys()][i], getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  storeSuppressed(storage, "a", "ok"); storeSuppressed(storage, "b", "yes"); store.set("other", "1");
  assert.equal(suppressedAnswer(storage, "a"), "ok");
  assert.deepEqual(readSuppressed(storage), { a: "ok", b: "yes" }, "what the app mirrors at state `dialog.suppressed`");
  assert.deepEqual(readSuppressed(null), {});
  assert.equal(suppressedAnswer(storage, "zz"), null);
  assert.equal(suppressedAnswer(null, "a"), null);
  assert.equal(resetSuppressed(storage, "a"), 1);
  assert.deepEqual([...store.keys()], [SUPPRESS_PREFIX + "b", "other"]);
  assert.equal(resetSuppressed(storage), 1);
  assert.deepEqual([...store.keys()], ["other"], "only mkui's keys go");
  assert.equal(resetSuppressed(null), 0);
  // The action's effect is invisible until a box next asks: it says so.
  assert.match(resetMessage(0), /^Nothing to reset/);
  assert.equal(resetMessage(1), "Will ask again (1 remembered answer forgotten)");
  assert.equal(resetMessage(3), "Will ask again (3 remembered answers forgotten)");
});

/* ── App.dialog / alert / confirm ────────────────────────────────────── */

test("App.confirm resolves true on OK, false on Cancel", async () => {
  const { app, opened } = makeApp();
  const yes = app.confirm("Proceed?", { title: "Sure" });
  await tick();
  assert.equal(opened[0].title, "Sure");
  assert.equal(textOf(opened[0], "mkui-dialog-para"), "Proceed?");
  buttonOf(opened[0], "OK").fire("click");
  assert.equal(await yes, true);

  const no = app.confirm("Proceed?");
  await tick();
  buttonOf(opened[1], "Cancel").fire("click");
  assert.equal(await no, false);
});

test("App.alert resolves once acknowledged", async () => {
  const { app, opened } = makeApp();
  let done = false;
  const p = app.alert("Saved.", { kind: "success" }).then((v) => { done = true; return v; });
  await tick();
  assert.equal(done, false);
  buttonOf(opened[0], "OK").fire("click");
  assert.equal(await p, undefined);
});

test("App.dialog opens a named dialog, its expressions seeing state and the app block", async () => {
  const { app, opened } = makeApp({
    app: { title: "Orders" }, state: { who: "ann" },
    dialogs: { hello: { title: "Hi ${state.who}", message: "Welcome to ${app.title}, ${extra}.", buttons: ["Later", "Now"] } },
  });
  const p = app.dialog("hello", { extra: "again" });
  await tick();
  assert.equal(opened[0].title, "Hi ann");
  assert.equal(textOf(opened[0], "mkui-dialog-para"), "Welcome to Orders, again.");
  buttonOf(opened[0], "Now").fire("click");
  assert.deepEqual(await p, { button: "now", data: {} });
});

test("App.dialog: an unknown name warns and resolves null", async () => {
  const { app, opened } = makeApp({ dialogs: {} });
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  try {
    assert.equal(await app.dialog("nope"), null);
    assert.equal(await app.dialog(null), null);
  } finally { console.warn = warn; }
  assert.equal(opened.length, 0);
  assert.deepEqual(warned, ["[mkui] unknown dialog: nope", "[mkui] unknown dialog: "]);
});

test("a confirm's `then` fires only on OK", async () => {
  for (const [label, expected] of [["OK", [["layout.reset", null]]], ["Cancel", []]]) {
    const { app, opened } = makeApp();
    const fired = [];
    app.registerAction("layout.reset", (_app, args) => fired.push(["layout.reset", args]));
    const p = app.dialog(confirmSpec({ message: "Reset?", then: { action: "layout.reset" } }));
    await tick();
    buttonOf(opened[0], label).fire("click");
    await p;
    assert.deepEqual(fired, expected, label);
  }
});

/* ── The menubar's `confirm` key ─────────────────────────────────────── */

const { MkuiMenubar } = await import("../mkui/static/src/components/menubar.js");

test("a menu item with confirm fires its action only after OK", async () => {
  for (const [answer, expected] of [["OK", [["app.reset", { hard: true }]]], ["Cancel", []]]) {
    const { app, opened } = makeApp();
    const fired = [];
    app.registerAction("app.reset", (_app, args) => fired.push(["app.reset", args]));
    const mb = new MkuiMenubar();
    mb._app = app;
    const done = mb._fire({ label: "Reset", action: "app.reset", args: { hard: true }, confirm: "Really reset?" });
    await tick();
    assert.equal(opened[0].title, "Reset");
    assert.equal(fired.length, 0, "nothing before the answer");
    buttonOf(opened[0], answer).fire("click");
    await done;
    assert.deepEqual(fired, expected, answer);
  }
});

test("a menu item without confirm fires at once, and one without an action does nothing", async () => {
  const { app, opened } = makeApp();
  const fired = [];
  app.registerAction("x.go", (_app, args) => fired.push(args));
  const mb = new MkuiMenubar();
  mb._app = app;
  await mb._fire({ label: "Go", action: "x.go", args: 1 });
  await mb._fire({ label: "Nothing", confirm: "?" });
  assert.deepEqual(fired, [1]);
  assert.equal(opened.length, 0);
});

test("confirmed: what a table button or a widget asks, seeing the context it was given", async () => {
  const { app, opened } = makeApp();
  assert.equal(await confirmed(app, { label: "Fill" }), true, "nothing to ask");
  assert.equal(await confirmed({}, { label: "Fill", confirm: "?" }), false, "nobody to ask: do not go ahead");
  const p = confirmed(app, { label: "Cancel", confirm: { message: "Cancel ${selection.count} order(s)?", kind: "danger" } }, { selection: { count: 3 } });
  await tick();
  assert.equal(textOf(opened[0], "mkui-dialog-para"), "Cancel 3 order(s)?");
  buttonOf(opened[0], "OK").fire("click");
  assert.equal(await p, true);
  const q = confirmed(app, { label: "Cancel", confirm: "Sure?" });
  await tick();
  buttonOf(opened[1], "Cancel").fire("click");
  assert.equal(await q, false);
});

test("the button widget asks before it fires", async () => {
  const { getWidget } = await import("../mkui/static/src/core.js");
  await import("../mkui/static/src/widgets/button.js");
  const { app, opened } = makeApp();
  const fired = [];
  app.registerAction("demo.clear", (_app, args) => fired.push(args));
  const host = el("div");
  getWidget("button")({ label: "Clear", action: "demo.clear", args: 1, confirm: "Clear?" }, app, host);
  host._ch[0].fire("click");
  await tick();
  assert.deepEqual(fired, []);
  buttonOf(opened[0], "OK").fire("click");
  await tick();
  assert.deepEqual(fired, [1]);
});

test("VERSION is what About reports", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
