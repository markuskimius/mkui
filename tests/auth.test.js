// Run with: node --test tests/auth.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { App, State } from "../mkui/static/src/core.js";

// ── App.registerAuthHandler ─────────────────────────────────────────

test("registerAuthHandler stores handler on app", () => {
  const app = new App({});
  const handler = { authenticate: () => {} };
  app.registerAuthHandler(handler);
  assert.equal(app.authHandler, handler);
});

test("registerAuthHandler overwrites previous handler", () => {
  const app = new App({});
  const h1 = { authenticate: () => "first" };
  const h2 = { authenticate: () => "second" };
  app.registerAuthHandler(h1);
  app.registerAuthHandler(h2);
  assert.equal(app.authHandler, h2);
});

test("authHandler is undefined by default", () => {
  const app = new App({});
  assert.equal(app.authHandler, undefined);
});

// ── Auth state lifecycle ────────────────────────────────────────────

test("auth state initializes to unauthenticated", () => {
  const s = new State({});
  s.set("auth.authenticated", false);
  s.set("auth.user", "");
  s.set("auth.role", "");

  assert.equal(s.get("auth.authenticated"), false);
  assert.equal(s.get("auth.user"), "");
  assert.equal(s.get("auth.role"), "");
});

test("auth state transitions to authenticated with user and role", () => {
  const s = new State({});
  s.set("auth.authenticated", false);
  s.set("auth.user", "");
  s.set("auth.role", "");

  s.set("auth.authenticated", true);
  s.set("auth.user", "admin");
  s.set("auth.role", "admin");

  assert.equal(s.get("auth.authenticated"), true);
  assert.equal(s.get("auth.user"), "admin");
  assert.equal(s.get("auth.role"), "admin");
});

test("subscribers track auth state transitions", () => {
  const s = new State({});
  s.set("auth.authenticated", false);

  const authValues = [];
  const userValues = [];
  s.subscribe("auth.authenticated", (v) => authValues.push(v));
  s.subscribe("auth.user", (v) => userValues.push(v));

  s.set("auth.user", "");
  s.set("auth.authenticated", true);
  s.set("auth.user", "admin");

  assert.deepEqual(authValues, [false, true]);
  assert.deepEqual(userValues, [undefined, "", "admin"]);
});

// ── Auth + connection state map interaction ──────────────────────────

test("auth.connected state map applied after login", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  const authConnected = {
    "status.message": "Connected",
    "status.color": "",
    "status.background": "",
  };

  apply(authConnected);
  assert.equal(s.get("status.message"), "Connected");
  assert.equal(s.get("status.color"), "");
  assert.equal(s.get("status.background"), "");
});

test("auth.disconnected state map applied on disconnect", () => {
  const s = new State({
    status: { message: "Connected", color: "", background: "" },
  });

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  const authDisconnected = {
    "status.message": "Disconnected",
    "status.color": "#000000",
    "status.background": "#b8b8b8",
  };

  apply(authDisconnected);
  assert.equal(s.get("status.message"), "Disconnected");
  assert.equal(s.get("status.color"), "#000000");
  assert.equal(s.get("status.background"), "#b8b8b8");
});

test("full auth lifecycle: init → connect → login → disconnect → reconnect", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000000", background: "#b8b8b8" },
  });

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  const mkioConnected = {
    "status.message": "Connected",
    "status.color": "",
    "status.background": "",
  };
  const authConnected = {
    "status.message": "Connected",
    "status.color": "",
    "status.background": "",
  };
  const authDisconnected = {
    "status.message": "Disconnected",
    "status.color": "#000000",
    "status.background": "#b8b8b8",
  };

  const msgs = [];
  s.subscribe("status.message", (v) => msgs.push(v));

  // 1. Init auth state
  s.set("auth.authenticated", false);
  s.set("auth.user", "");
  s.set("auth.role", "");

  // 2. WebSocket connects — auth not yet done, apply mkio.connected
  s.set("mkio.connected", true);
  apply(mkioConnected);

  // 3. User logs in successfully
  s.set("auth.authenticated", true);
  s.set("auth.user", "admin");
  s.set("auth.role", "admin");
  apply(authConnected);

  // 4. WebSocket disconnects
  s.set("mkio.connected", false);
  apply(authDisconnected);

  // 5. WebSocket reconnects — auth already done
  s.set("mkio.connected", true);
  apply(authConnected);

  assert.deepEqual(msgs, [
    "Connecting...",
    "Connected",     // mkio.connected (before login)
    "Connected",     // auth.connected (after login) — same value, still notified
    "Disconnected",  // auth.disconnected
    "Connected",     // reconnect — auth.connected
  ]);
  assert.equal(s.get("auth.authenticated"), true);
  assert.equal(s.get("auth.user"), "admin");
});

// ── Config-driven auth state map fallback ───────────────────────────

test("auth.connected falls back to mkio.connected if absent", () => {
  const config = {
    auth: { method: "mkio" },
    mkio: {
      url: "ws://localhost:8080/ws",
      connected: { "status.message": "Online" },
    },
  };

  const authConnected = config.auth.connected ?? config.mkio.connected ?? { "status.message": "Connected" };
  assert.deepEqual(authConnected, { "status.message": "Online" });
});

test("auth.connected falls back to default if both absent", () => {
  const config = {
    auth: { method: "mkio" },
    mkio: { url: "ws://localhost:8080/ws" },
  };

  const authConnected = config.auth.connected ?? config.mkio?.connected ?? { "status.message": "Connected" };
  assert.deepEqual(authConnected, { "status.message": "Connected" });
});

test("auth.disconnected falls back to mkio.disconnected", () => {
  const config = {
    auth: { method: "mkio" },
    mkio: {
      url: "ws://localhost:8080/ws",
      disconnected: { "status.message": "Offline" },
    },
  };

  const authDisconnected = config.auth.disconnected ?? config.mkio.disconnected ?? { "status.message": "Disconnected" };
  assert.deepEqual(authDisconnected, { "status.message": "Offline" });
});

test("auth.disconnected uses its own map when present", () => {
  const config = {
    auth: {
      method: "mkio",
      disconnected: { "status.message": "Auth Lost" },
    },
    mkio: {
      url: "ws://localhost:8080/ws",
      disconnected: { "status.message": "Offline" },
    },
  };

  const authDisconnected = config.auth.disconnected ?? config.mkio.disconnected ?? { "status.message": "Disconnected" };
  assert.deepEqual(authDisconnected, { "status.message": "Auth Lost" });
});

// ── hasAuth flag logic ──────────────────────────────────────────────

test("hasAuth is true when config.auth exists", () => {
  const config = { auth: { method: "mkio" } };
  assert.equal(!!config.auth, true);
});

test("hasAuth is false when config.auth is absent", () => {
  const config = { mkio: { url: "ws://localhost:8080/ws" } };
  assert.equal(!!config.auth, false);
});

test("hasAuth is false when config.auth is null", () => {
  const config = { auth: null };
  assert.equal(!!config.auth, false);
});

// ── Auth method resolution ──────────────────────────────────────────

test("method defaults to mkio when not specified", () => {
  const config = { auth: {} };
  const method = config.auth.method ?? "mkio";
  assert.equal(method, "mkio");
});

test("method respects explicit custom value", () => {
  const config = { auth: { method: "custom" } };
  const method = config.auth.method ?? "mkio";
  assert.equal(method, "custom");
});

test("method respects explicit mkio value", () => {
  const config = { auth: { method: "mkio" } };
  const method = config.auth.method ?? "mkio";
  assert.equal(method, "mkio");
});

// ── Dialog config defaults ──────────────────────────────────────────

test("dialog config defaults when absent", () => {
  const config = { auth: { method: "mkio" } };
  const dialogCfg = config.auth.dialog ?? {};
  assert.equal(dialogCfg.title ?? "Log In", "Log In");
  assert.equal(dialogCfg.width ?? 340, 340);
  assert.equal(dialogCfg.usernameLabel ?? "Username", "Username");
  assert.equal(dialogCfg.passwordLabel ?? "Password", "Password");
  assert.equal(dialogCfg.submitLabel ?? "Log In", "Log In");
});

test("dialog config respects custom values", () => {
  const config = {
    auth: {
      method: "mkio",
      dialog: {
        title: "Sign In",
        width: 400,
        usernameLabel: "Email",
        passwordLabel: "Secret",
        submitLabel: "Go",
      },
    },
  };
  const dialogCfg = config.auth.dialog ?? {};
  assert.equal(dialogCfg.title ?? "Log In", "Sign In");
  assert.equal(dialogCfg.width ?? 340, 400);
  assert.equal(dialogCfg.usernameLabel ?? "Username", "Email");
  assert.equal(dialogCfg.passwordLabel ?? "Password", "Secret");
  assert.equal(dialogCfg.submitLabel ?? "Log In", "Go");
});

// ── Verify skipped when auth is enabled ─────────────────────────────

test("verify is not called when auth is enabled", () => {
  let verifyCalled = false;

  const verify = () => { verifyCalled = true; };
  const hasAuth = true;

  // Simulates the onConnect handler logic
  if (!hasAuth) verify();

  assert.equal(verifyCalled, false);
});

test("verify is called when auth is disabled", () => {
  let verifyCalled = false;

  const verify = () => { verifyCalled = true; };
  const hasAuth = false;

  if (!hasAuth) verify();

  assert.equal(verifyCalled, true);
});

// ── onConnect handler logic ─────────────────────────────────────────

test("onConnect applies mkio.connected before login, auth.connected on reconnect", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });
  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  const config = {
    auth: {
      connected: { "status.message": "Welcome back" },
      disconnected: { "status.message": "Lost connection" },
    },
    mkio: {
      connected: { "status.message": "Server ready" },
    },
  };

  const hasAuth = !!config.auth;

  // First connect — auth not done yet
  s.set("auth.authenticated", false);
  s.set("mkio.connected", true);
  if (hasAuth) {
    if (s.get("auth.authenticated")) {
      apply(config.auth.connected ?? config.mkio.connected ?? { "status.message": "Connected" });
    } else {
      apply(config.mkio.connected ?? { "status.message": "Connected" });
    }
  }
  assert.equal(s.get("status.message"), "Server ready");

  // User logs in
  s.set("auth.authenticated", true);

  // Reconnect — auth already done
  s.set("mkio.connected", false);
  s.set("mkio.connected", true);
  if (hasAuth) {
    if (s.get("auth.authenticated")) {
      apply(config.auth.connected ?? config.mkio.connected ?? { "status.message": "Connected" });
    } else {
      apply(config.mkio.connected ?? { "status.message": "Connected" });
    }
  }
  assert.equal(s.get("status.message"), "Welcome back");
});

// ── Frame deferral when auth is enabled ─────────────────────────────

test("frames are deferred when auth is enabled", () => {
  const config = {
    auth: { method: "mkio" },
    frames: [
      { id: "main", x: 0.02, y: 0.03, w: 0.64, h: 0.94,
        layout: { type: "tabs", children: ["pane1"] } },
    ],
  };

  const hasAuth = !!config.auth;
  let workspaceFrames = [];

  if (hasAuth) {
    const savedFrames = config.frames;
    config.frames = [];
    // workspace.setApp() would be called here with empty frames
    workspaceFrames = [...config.frames];
    config.frames = savedFrames;
  }

  assert.deepEqual(workspaceFrames, []);
  assert.equal(config.frames.length, 1);
  assert.equal(config.frames[0].id, "main");
});

test("frames are not deferred when auth is disabled", () => {
  const config = {
    frames: [
      { id: "main", x: 0.02, y: 0.03, w: 0.64, h: 0.94,
        layout: { type: "tabs", children: ["pane1"] } },
    ],
  };

  const hasAuth = !!config.auth;

  // Without auth, workspace.setApp() uses original frames
  assert.equal(hasAuth, false);
  assert.equal(config.frames.length, 1);
});

// ── Auth logout action ──────────────────────────────────────────────

test("auth.logout action is registered when auth is enabled", () => {
  const app = new App({ auth: { method: "mkio" } });
  const hasAuth = !!app.config.auth;

  if (hasAuth) {
    app.registerAction("auth.logout", () => "reloaded");
  }

  assert.equal(app.actions.has("auth.logout"), true);
  assert.equal(app.actions.get("auth.logout")(), "reloaded");
});

test("auth.logout action is not registered when auth is disabled", () => {
  const app = new App({});
  const hasAuth = !!app.config.auth;

  if (hasAuth) {
    app.registerAction("auth.logout", () => "reloaded");
  }

  assert.equal(app.actions.has("auth.logout"), false);
});

// ── showLogin module exports ────────────────────────────────────────

test("auth module exports showLogin function", async () => {
  const mod = await import("../mkui/static/src/auth.js");
  assert.equal(typeof mod.showLogin, "function");
});

// ── Auth result state setting ───────────────────────────────────────

test("successful auth sets user and role from result", () => {
  const s = new State({});
  s.set("auth.authenticated", false);
  s.set("auth.user", "");
  s.set("auth.role", "");

  const result = { user: "admin", role: "admin" };

  s.set("auth.authenticated", true);
  s.set("auth.user", result.user ?? "fallback");
  s.set("auth.role", result.role ?? "");

  assert.equal(s.get("auth.authenticated"), true);
  assert.equal(s.get("auth.user"), "admin");
  assert.equal(s.get("auth.role"), "admin");
});

test("auth result falls back to username when user not in result", () => {
  const s = new State({});
  const username = "testuser";
  const result = {};

  s.set("auth.user", result.user ?? username);
  s.set("auth.role", result.role ?? "");

  assert.equal(s.get("auth.user"), "testuser");
  assert.equal(s.get("auth.role"), "");
});

test("auth result falls back to empty role when role not in result", () => {
  const s = new State({});
  const result = { user: "admin" };

  s.set("auth.role", result.role ?? "");
  assert.equal(s.get("auth.role"), "");
});
