// Run with: node --test tests/field-types.test.js
//
// Registered dialog field types: the registry, how the dialog decides a
// `type` is one, and the Enter rule an editor depends on. The dialog's DOM
// side is driven in a browser (README "Running the examples": the
// library-js example's App → Custom Fields…).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFieldType, getFieldType } from "../mkui/static/src/core.js";
import { FIELD_TYPES } from "../mkui/static/src/lib/dialogs.js";
import { keepsEnter, fieldTypeOf } from "../mkui/static/src/widgets/mkui-dialog.js";

function capture(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return warned;
}

const factory = () => ({ el: {}, get: () => "", set: () => {} });

test("a registered type is found by name", () => {
  registerFieldType("ft-basic", factory);
  assert.equal(getFieldType("ft-basic"), factory);
  assert.equal(getFieldType("ft-nobody"), undefined);
});

test("a built-in name is refused, and stays built in", () => {
  for (const name of FIELD_TYPES) {
    const warned = capture(() => registerFieldType(name, factory));
    assert.equal(getFieldType(name), undefined, name);
    assert.match(warned[0], /built-in field type/);
  }
});

test("a factory must be a function", () => {
  const warned = capture(() => registerFieldType("ft-bad", { el: {} }));
  assert.equal(getFieldType("ft-bad"), undefined);
  assert.match(warned[0], /factory function/);
});

test("registering a name again replaces the factory, and says so", () => {
  const second = () => ({ el: {}, get: () => "x", set: () => {} });
  registerFieldType("ft-again", factory);
  const warned = capture(() => registerFieldType("ft-again", second));
  assert.equal(getFieldType("ft-again"), second);
  assert.match(warned[0], /registered again/);
});

test("fieldTypeOf: built-ins and no type are the dialog's own", () => {
  for (const type of [...FIELD_TYPES, undefined, null]) {
    assert.equal(fieldTypeOf(type), null, String(type));
  }
});

test("fieldTypeOf: a registered type is its factory", () => {
  registerFieldType("ft-lookup", factory);
  assert.equal(fieldTypeOf("ft-lookup"), factory);
});

test("fieldTypeOf: an unknown type is a text box, warned once", () => {
  const warned = capture(() => {
    assert.equal(fieldTypeOf("ft-misspelt"), null);
    assert.equal(fieldTypeOf("ft-misspelt"), null);
  });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /unknown field type "ft-misspelt"/);
});

// A target as the key handler sees one: a tag, maybe editable, maybe
// inside a wrapper that keeps Enter.
const target = ({ tag = "DIV", editable = false, inKeeper = false } = {}) => ({
  tagName: tag,
  isContentEditable: editable,
  closest: (sel) => (inKeeper && sel === ".mkui-dialog-keeps-enter" ? {} : null),
});

test("keepsEnter: a single-line input submits", () => {
  assert.equal(keepsEnter(target({ tag: "INPUT" })), false);
  assert.equal(keepsEnter(target({ tag: "SELECT" })), false);
  assert.equal(keepsEnter(null), false);
});

test("keepsEnter: a textarea, a button and a link keep it, as before", () => {
  for (const tag of ["TEXTAREA", "BUTTON", "A"]) assert.equal(keepsEnter(target({ tag })), true, tag);
});

test("keepsEnter: anything editable keeps it — an editor's newline", () => {
  assert.equal(keepsEnter(target({ tag: "P", editable: true })), true);
});

test("keepsEnter: an input inside a field that keepsEnter keeps it — a tag box", () => {
  assert.equal(keepsEnter(target({ tag: "INPUT", inKeeper: true })), true);
});
