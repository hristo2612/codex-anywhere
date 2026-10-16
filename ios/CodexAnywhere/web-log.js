// codex-anywhere iOS: forwards page warnings, errors and frame loads to the
// app's log (WebLog in AppModel.swift). Injected at document start into every
// frame; only the app's own frames (the main frame and same-origin iframes such
// as the voice window) use it, through the main frame's handler. Swift answers
// only the main frame of the server's origin (FrameGuard.swift).
(() => {
  let main;
  try {
    main = window.top;
    if (main !== window && main.location.origin !== location.origin) return;
  } catch { return; }
  const h = main.webkit?.messageHandlers?.codexAnywhereLog;
  if (!h || window.__codexAnywhereLog) return;
  window.__codexAnywhereLog = true;
  const frame = (window === top ? "top" : "sub") + " " + location.pathname + location.search.slice(0, 60);
  const text = (a) => { try { return a instanceof Error ? a.stack || String(a) : typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
  const send = (level, args) => { try { h.postMessage(level + " [" + frame + "] " + Array.from(args, text).join(" ").slice(0, 2000)); } catch {} };
  for (const level of ["warn", "error"]) {
    const original = console[level];
    console[level] = function (...args) { send(level, args); return original.apply(this, args); };
  }
  addEventListener("error", (e) => send("uncaught", [e.error || e.message]));
  addEventListener("unhandledrejection", (e) => send("rejection", [e.reason]));
  send("load", []);
})();
