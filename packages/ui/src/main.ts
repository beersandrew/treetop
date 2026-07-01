import { mount } from "svelte";
import { initDaemonKV } from "./daemon-kv";
import {
  openUrl,
  resolveLocalFileMarkdownHref,
  shouldOpenHrefOutsideApp,
} from "./open-url";
import {
  configure,
  DEFAULT_MAPPINGS,
  installGestureListener,
  playOnFirstGesture,
} from "./sound";
import { startPeerWatcher } from "./peer-watcher";
import { windowTitle } from "../../../product";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/popover.css";
import "./styles/agent-row.css";
import "./styles/new-session.css";
import "./styles/source-control.css";
import "./styles/zen-row.css";
import "./styles/overlays.css";
import "./styles/header.css";
import "./styles/diagnostics.css";
import "./styles/worktree-row.css";
import "./styles/wt-picker.css";
import "./styles/notes.css";
import "./styles/file-browser.css";
import "./styles/task-queue.css";
import App from "./App.svelte";

// Distinguish the dev tab from the prod tab in the browser. Bookmark
// suggestions and the tab title both surface this text, so two browser
// bookmarks named "Jungle" / "Jungle · dev" stay visually correct.
// `import.meta.env.DEV` is Vite's compile-time flag — true under
// `vite` (port 7779), false in the production `bun run start` build.
// Name comes from the shared product module (single source of truth).
document.title = windowTitle(import.meta.env.DEV);

// Block browser back navigation (trackpad swipe, back button, Cmd+[).
// supergit is a single-screen dashboard; "going back" lands on whatever
// the user was on before, which is never what they want here. Seed one
// extra history entry and re-push on every popstate so the back gesture
// is a no-op.
history.pushState(null, "", location.href);
window.addEventListener("popstate", () => {
  history.pushState(null, "", location.href);
});

// Intercept navigational <a> clicks and route them through the daemon so
// they open in the OS browser. In WKWebView (native app), even same-origin
// localhost links would navigate/reload the app shell itself.
document.addEventListener("click", (ev) => {
  if (ev.defaultPrevented) return;
  const a = (ev.target as HTMLElement)?.closest?.(
    "a[href]",
  ) as HTMLAnchorElement | null;
  if (!a) return;
  const fileHref = a.getAttribute("data-supergit-file-href");
  if (fileHref) {
    const owner = a.closest(
      "[data-supergit-session-cwd]",
    ) as HTMLElement | null;
    const filePath = resolveLocalFileMarkdownHref(
      fileHref,
      owner?.dataset.supergitSessionCwd,
    );
    if (filePath) {
      ev.preventDefault();
      openUrl(filePath);
      return;
    }
  }
  if (!shouldOpenHrefOutsideApp(a.getAttribute("href"), location.href)) return;
  ev.preventDefault();
  openUrl(a.href);
});

// Mark Windows clients so CSS can target them. Used by worktree-row.css
// to give the horizontal sessions-strip scrollbar a taller hit-target on
// Windows, where the default 8px scrollbar feels noticeably harder to
// grab than on macOS' overlay scrollbars.
if (/Windows/.test(navigator.userAgent)) {
  document.body.classList.add("platform-windows");
}

// Pause all CSS animations when the tab is backgrounded. Chrome
// already throttles JS timers / RAFs in hidden tabs but keeps CSS
// animations running, so the compositor still pays for the always-on
// idle pulses, badge sweeps and conic rings while you're not looking.
// Toggling a body class drives the `body.tab-hidden *` rule in
// base.css to stop them at the source. Read once at startup so a tab
// opened in the background starts paused.
function syncTabVisibilityClass() {
  document.body.classList.toggle("tab-hidden", document.hidden);
}
syncTabVisibilityClass();
document.addEventListener("visibilitychange", syncTabVisibilityClass);

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in index.html");

// Seed localStorage from daemon prefs before mounting so all store
// constructors see shared state (native app inherits browser layout).
await initDaemonKV();

configure(DEFAULT_MAPPINGS);
installGestureListener();
playOnFirstGesture("app-startup");
startPeerWatcher();

const app = mount(App, { target });

// The vines overlay (./vines) is mounted by App.svelte, driven by the
// "Show vines" setting (Appearance). Demo URL params ?vinesgrow /
// ?vinesspeed / ?vinesdebug are read inside the module.

export default app;
