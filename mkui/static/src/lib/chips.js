// Chips — the little pill controls a pane puts in its toolbar to say what
// is currently shaping what it shows: a sort key, a filter, a link, the
// record a detail window is about.
//
// A chip is a label with two hit targets: the body (click acts on the
// thing — flip the sort, open the dropdown, pause the link) and an `×`
// (remove it). A group gathers the chips of one kind behind a lead icon
// which clears the lot; the icon travels *inside* the first chip's lead
// span so a wrapped line never starts with an orphaned icon.
//
// These were closures inside `mkio-table` until the record panes needed
// the same pills. They live here so both render the same DOM: one set of
// class names, checked once (`tests/styles.test.js`), styled once.

import { icon } from "./icons.js";

// How long a multi-name chip's `×` stays armed, waiting for the second
// click that confirms removing several links at once.
export const REMOVE_ARM_MS = 4000;

export const linkDirWord = (dir) => (dir === "broadcast" ? "Broadcast" : "Listen");
export const linkIcon = (dir) => icon(dir === "broadcast" ? "radio" : "ear");

// `{ chip, main }` — the pill and its body button. `lead` goes in the chip
// ahead of the button (a filter's on/off box); `mark` goes inside the
// button ahead of the label (a link's direction icon).
export function makeChip(cls, col, text, title, onClick, onClear, lead = null, mark = null) {
  const chip = document.createElement("span");
  chip.className = "mkui-chip " + cls;
  chip.dataset.col = col;
  chip.title = title;
  if (lead) chip.appendChild(lead);
  const main = document.createElement("button");
  main.className = "mkui-chip-main";
  main.type = "button";
  if (mark) main.appendChild(mark);
  const label = document.createElement("span");
  label.className = "mkui-chip-text";
  label.textContent = text;
  main.appendChild(label);
  main.addEventListener("click", onClick);
  const x = document.createElement("button");
  x.className = "mkui-chip-x";
  x.type = "button";
  x.title = "Remove";
  x.appendChild(icon("close"));
  x.addEventListener("click", (e) => { e.stopPropagation(); onClear(); });
  chip.append(main, x);
  return { chip, main };
}

export function makeGroup(cls, iconName, title, onClear, chips) {
  const group = document.createElement("span");
  group.className = "mkui-chip-group " + cls;
  // The icon travels with the first chip so a wrapped line never starts
  // with an orphaned icon (see .mkui-chip-lead).
  const lead = document.createElement("span");
  lead.className = "mkui-chip-lead";
  const btn = document.createElement("button");
  btn.className = "mkui-chip-icon";
  btn.type = "button";
  btn.title = title;
  // The group's icon with an × badge in its corner: it is a clear
  // button, not a state indicator like the header's tinted icon.
  const badge = document.createElement("span");
  badge.className = "mkui-chip-icon-x";
  badge.appendChild(icon("close"));
  btn.append(icon(iconName), badge);
  btn.addEventListener("click", onClear);
  lead.append(btn, chips[0]);
  group.appendChild(lead);
  for (const c of chips.slice(1)) group.appendChild(c);
  return group;
}

// The two-click guard on an `×` that would remove several things at once:
// the first click arms the chip (`.mkui-chip-arm`, a warning tooltip) and
// the second, within REMOVE_ARM_MS, goes through. Returns a function to
// call from the chip's `onClear`; `n <= 1` never arms.
export function armedClear(chip, n, what, title, run) {
  let timer = null;
  return () => {
    if (n > 1 && !chip.classList.contains("mkui-chip-arm")) {
      chip.classList.add("mkui-chip-arm");
      chip.title = `Click × again to remove ${what}`;
      timer = setTimeout(() => {
        chip.classList.remove("mkui-chip-arm");
        chip.title = title;
      }, REMOVE_ARM_MS);
      return;
    }
    if (timer) clearTimeout(timer);
    run();
  };
}
