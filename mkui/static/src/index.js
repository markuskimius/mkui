// mkui entry point. Importing this file registers all custom elements and
// built-in widgets / pane types as a side effect, and exports the public
// library-mode API.

import "./components/app.js";
import "./widgets/text.js";
import "./widgets/button.js";
import "./widgets/mkio-table.js";
import "./widgets/mkio-history.js";
import "./widgets/mkio-record.js";

export {
  VERSION, version,
  App, State, LinkHub,
  registerWidget, registerPaneType,
  registerExprFunction, registerExprLibrary, registerExprType, expr,
  getWidget, getPaneType, getPaneTypeKeys,
} from "./core.js";
export { ensureMkio } from "./mkio-bridge.js";
// The record subject: what a custom detail pane needs to follow the link
// hub the way the built-in ones do (see lib/subject.js).
export { attachRecord, RecordFollower, parseRecordSpec, recordFilter } from "./lib/subject.js";

// The dialog a custom action opens — a form, or with `message` and
// `buttons` a message box. `app.dialog` / `app.alert` / `app.confirm` are
// the short way in; this is the whole signature.
export { openDialog } from "./widgets/mkui-dialog.js";

// Convenience global for non-module <script> users.
import * as Mkui from "./core.js";
import { ensureMkio } from "./mkio-bridge.js";
import { openDialog } from "./widgets/mkui-dialog.js";
if (typeof window !== "undefined") {
  window.mkui = window.Mkui = { ...Mkui, ensureMkio, openDialog };
}
