// Config-driven authentication gate.
//
// When config.auth exists, showLogin() displays a login dialog and
// authenticates before the app proceeds. Supports two methods:
//
//   method: "mkio"   — calls client.auth({username, password})
//   method: "custom" — calls app.authHandler.authenticate({username, password})
//
// When config.auth is absent, the app loads without a login prompt.

import { ensureMkio } from "./mkio-bridge.js";

export function showLogin(config, app, client) {
  return new Promise((resolve) => {
    const ws = app._element?._workspace;
    if (!ws) { resolve(null); return; }

    const authCfg = config.auth;
    const dialogCfg = authCfg.dialog ?? {};

    const paneId = "_auth-login";
    ws.registerPane(paneId, {
      title: dialogCfg.title ?? "Log In",
      type: "_auth",
    });

    const wsRect = ws.getBoundingClientRect();
    const widthPx = dialogCfg.width ?? 340;
    const wFrac = Math.min(widthPx / wsRect.width, 0.9);
    const hFrac = Math.min(0.35, 240 / wsRect.height);
    const xFrac = Math.max(0, (1 - wFrac) / 2);
    const yFrac = Math.max(0, (1 - hFrac) / 2);

    const frameId = ws.addFrame({
      x: xFrac, y: yFrac, w: wFrac, h: hFrac,
      stayOnTop: true,
      noDock: true,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });

    const paneEl = ws._paneEls.get(paneId);
    if (!paneEl) { resolve(null); return; }
    const host = paneEl.contentEl;
    host.textContent = "";

    const container = document.createElement("div");
    container.className = "mkui-dialog-content";

    const body = document.createElement("div");
    body.className = "mkui-dialog-body";

    const makeField = (name, label, type, placeholder, autocomplete) => {
      const wrapper = document.createElement("div");
      wrapper.className = "mkui-dialog-field";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      wrapper.appendChild(lbl);
      const input = document.createElement("input");
      input.type = type;
      input.name = name;
      if (placeholder) input.placeholder = placeholder;
      if (autocomplete) input.autocomplete = autocomplete;
      wrapper.appendChild(input);
      return { wrapper, input };
    };

    const user = makeField("username", dialogCfg.usernameLabel ?? "Username", "text", "Username", "username");
    const pass = makeField("password", dialogCfg.passwordLabel ?? "Password", "password", "Password", "current-password");
    body.appendChild(user.wrapper);
    body.appendChild(pass.wrapper);
    container.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "mkui-dialog-footer";

    const status = document.createElement("span");
    status.className = "mkui-dialog-status";
    footer.appendChild(status);

    const submitBtn = document.createElement("button");
    submitBtn.className = "mkui-btn mkui-btn-primary";
    submitBtn.textContent = dialogCfg.submitLabel ?? "Log In";

    footer.appendChild(submitBtn);
    container.appendChild(footer);
    host.appendChild(container);

    user.input.focus();

    let submitting = false;

    async function submit() {
      if (submitting) return;
      const username = user.input.value.trim();
      const password = pass.input.value;

      let invalid = false;
      for (const f of [user, pass]) {
        f.wrapper.classList.remove("mkui-dialog-invalid");
        const existing = f.wrapper.querySelector(".mkui-dialog-error");
        if (existing) existing.remove();
      }
      if (!username) {
        user.wrapper.classList.add("mkui-dialog-invalid");
        invalid = true;
      }
      if (!password) {
        pass.wrapper.classList.add("mkui-dialog-invalid");
        invalid = true;
      }
      if (invalid) return;

      submitting = true;
      submitBtn.disabled = true;
      status.textContent = "Authenticating...";
      status.className = "mkui-dialog-status";

      try {
        let result;
        const method = authCfg.method ?? "mkio";

        if (method === "mkio") {
          if (!client) throw new Error("No mkio connection");
          result = await client.auth({ username, password });
        } else if (method === "custom") {
          const handler = app.authHandler;
          if (!handler?.authenticate) throw new Error("No auth handler registered");
          result = await handler.authenticate({ username, password });
        } else {
          throw new Error(`Unknown auth method: ${method}`);
        }

        const st = app.state;
        st.set("auth.authenticated", true);
        st.set("auth.user", result.user ?? username);
        st.set("auth.role", result.role ?? "");

        ws.closeFrame(frameId);
        ws.unregisterPane(paneId);
        resolve(result);
      } catch (err) {
        status.textContent = err.message || "Authentication failed";
        status.className = "mkui-dialog-status mkui-dialog-status-error";
        submitting = false;
        submitBtn.disabled = false;
        pass.input.value = "";
        pass.input.focus();
      }
    }

    submitBtn.addEventListener("click", submit);
    host.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    // Prevent closing the login dialog via the frame's close button
    const frameEl = ws._frameEls.get(frameId);
    if (frameEl) {
      frameEl._extraControls = () => [];
      frameEl._hideClose = true;
      frameEl._renderInternal();
    }
  });
}
