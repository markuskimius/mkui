// mkui entry point. Importing this file registers all custom elements and
// built-in widgets / pane types as a side effect, and exports the public
// library-mode API.

import "./components/app.js";
import "./widgets/text.js";
import "./widgets/button.js";
import "./widgets/mkio-table.js";

export {
  App, State,
  registerWidget, registerPaneType,
  getWidget, getPaneType,
} from "./core.js";
export { ensureMkio } from "./mkio-bridge.js";

// Convenience global for non-module <script> users.
import * as Mkui from "./core.js";
import { ensureMkio } from "./mkio-bridge.js";
if (typeof window !== "undefined") {
  window.Mkui = { ...Mkui, ensureMkio };
}
