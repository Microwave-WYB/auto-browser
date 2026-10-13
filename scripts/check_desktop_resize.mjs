// Isolated (no ports, mounts of data or live stack):
// docker run --rm --network none --shm-size=1g --entrypoint node \
//   -v "$PWD/scripts:/opt/browser-node/checks:ro" \
//   IMAGE /opt/browser-node/checks/check_desktop_resize.mjs --isolated
// Existing endpoint (creates/closes only its own synthetic browser context):
// WARNING: it still resizes the shared desktop and affects ALL contexts/tabs.
// Run only during an authorized maintenance window with no competing active user client.
// TAKEOVER_URL=... BROWSER_WS_ENDPOINT=... node check_desktop_resize.mjs
// Optional VNC_PASSWORD is read from env, never a command-line argument.
// RESIZE_EVIDENCE_DIR defaults to /tmp/desktop-resize-evidence (fixture screenshots only).
// Mount an empty evidence directory there to retain screenshots after --rm.
// Outside the container, run this script where the Playwright package is installed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const xCheck = fileURLToPath(new URL("./check_desktop_x_windows.py", import.meta.url));

const isolated = process.argv.includes("--isolated");
const xDisplay = isolated ? ":99" : process.env.RESIZE_X_DISPLAY;
const password = process.env.VNC_PASSWORD;
const endpointFile = "/data/profile/browser-ws-endpoint.txt";
const evidence = process.env.RESIZE_EVIDENCE_DIR || "/tmp/desktop-resize-evidence";
let stack, clientBrowser, browser, context;
const deadline = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out")), 15000);
  })]).finally(() => clearTimeout(timer));
};

async function connectClient(client, takeover) {
  await client.goto(takeover);
  await deadline(client.evaluate(async (password) => {
    const { default: UI } = await import("./app/ui.js");
    window.noVNCUI = UI;
    const rfb = UI.rfb || await new Promise(resolve => Object.defineProperty(UI, "rfb", {
      configurable: true,
      get: () => undefined,
      set: value => {
        Object.defineProperty(UI, "rfb", { value, writable: true, configurable: true });
        resolve(value);
      },
    }));
    if (password) {
      rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password }));
      if (rfb._rfbInitState === "Authentication") rfb.sendCredentials({ password });
    }
    if (rfb._rfbConnectionState === "connected") return;
    await new Promise((resolve, reject) => {
      rfb.addEventListener("connect", resolve, { once: true });
      rfb.addEventListener("disconnect", () => reject(new Error("VNC connection refused")), { once: true });
    });
  }, password), "real noVNC connection");
  assert(await client.evaluate(() => window.noVNCUI.connected), "noVNC UI must be connected");
  assert(await client.evaluate(() => window.noVNCUI.rfb.resizeSession), "remote resize must be selected");
  await deadline(client.evaluate(() => {
    const display = window.noVNCUI.rfb._display;
    const canvas = document.querySelector("#noVNC_container canvas");
    return new Promise(resolve => {
      const flip = display.flip.bind(display);
      const check = () => {
        if (!canvas.width || !canvas.height) return;
        if (!canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
          .data.slice(0, 3).some(value => value !== 0)) return;
        display.flip = flip;
        resolve();
      };
      display.flip = (...args) => { flip(...args); check(); };
      check();
    });
  }), "first non-black rendered noVNC frame");
  await client.locator("#noVNC_transition").waitFor({ state: "hidden", timeout: 15000 });
  await client.evaluate(() => {
    window.noVNCUI.hideStatus();
    window.noVNCUI.closeControlbar();
  });
  await client.waitForFunction(() => getComputedStyle(document.getElementById("noVNC_status")).opacity === "0", null, { timeout: 15000 });
}

try {
  if (isolated) {
    // This option is only for a disposable container, never a host/live stack.
    await mkdir("/data/profile", { recursive: true });
    const ready = new Promise((resolve, reject) => {
      const watcher = watch("/data/profile", async (_, name) => {
        if (name !== "browser-ws-endpoint.txt") return;
        watcher.close();
        resolve();
      });
      stack = spawn("/entrypoint.sh", [], { stdio: "inherit" });
      stack.once("exit", code => { watcher.close(); reject(new Error("stack exited " + code)); });
    });
    await deadline(ready, "isolated Playwright endpoint");
  }
  delete process.env.VNC_PASSWORD;
  const endpoint = isolated
    ? (await readFile(endpointFile, "utf8")).trim().replace("browser-node", "127.0.0.1")
    : process.env.BROWSER_WS_ENDPOINT;
  assert(endpoint, "BROWSER_WS_ENDPOINT is required outside --isolated");
  const takeover = isolated ? "http://127.0.0.1:6080/vnc.html?autoconnect=true"
    : process.env.TAKEOVER_URL;
  assert(takeover, "TAKEOVER_URL is required outside --isolated");
  browser = await chromium.connect(endpoint);
  context = await browser.newContext({ viewport: null });
  const desktop = await context.newPage();
  const cdp = await context.newCDPSession(desktop);
  await desktop.goto("data:text/html,<title>Resize fixture</title><input id=typing><button onclick='alert(42)'>Dialog</button>");
  clientBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const client = await clientBrowser.newPage({ viewport: { width: 1366, height: 768 } });
  await connectClient(client, takeover);

  for (const size of [{ width: 1366, height: 768 }, { width: 391, height: 844 }, { width: 1600, height: 900 }]) {
    // Observers/events, not sleeps or fixed polling, track the actual resize.
    await client.evaluate(size => {
      const canvas = document.querySelector("#noVNC_container canvas");
      window.resizeResult = new Promise(resolve => {
        const check = () => {
          if (canvas.width !== size.width || canvas.height !== size.height) return;
          observer.disconnect();
          resolve({ width: canvas.width, height: canvas.height });
        };
        const observer = new ResizeObserver(check);
        observer.observe(canvas);
        check();
      });
    }, size);
    await desktop.evaluate(size => {
      window.nativeResizeResult = new Promise(resolve => {
        const check = () => {
          if (screen.width !== size.width || screen.height !== size.height || innerWidth !== size.width) return;
          removeEventListener("resize", check);
          resolve({ width: innerWidth, height: innerHeight, outerWidth, outerHeight, screenX, screenY,
                    screenWidth: screen.width, screenHeight: screen.height });
        };
        addEventListener("resize", check);
        check();
      });
    }, size);
    await client.setViewportSize(size);
    const framebuffer = await deadline(client.evaluate(() => window.resizeResult), "noVNC framebuffer resize");
    const native = await deadline(desktop.evaluate(() => window.nativeResizeResult), "native Chrome resize");
    await mkdir(evidence, { recursive: true });
    await client.screenshot({ path: evidence + "/" + size.width + "x" + size.height + ".png" });
    const { bounds } = await cdp.send("Browser.getWindowForTarget");
    // Chromium reports a 500px JS outerWidth floor even when the actual X window
    // and CDP bounds are 391px. Check native bounds, not that misleading metric.
    assert.deepEqual(framebuffer, size);
    assert.equal(bounds.width, size.width);
    assert.equal(bounds.height, size.height);
    assert.equal(bounds.left, 0);
    assert.equal(bounds.top, 0);
    assert.equal(native.screenX, 0);
    assert.equal(native.screenY, 0);
    assert(native.height < size.height && size.height - native.height >= 60, "tabs and toolbar must not be fullscreen/clipped");
    console.log("PASS resize", JSON.stringify({ framebuffer, native }));
  }
  // A second native tab and a client reconnect must retain native sizing.
  const tab = await context.newPage();
  await tab.goto("data:text/html,<title>Second resize fixture</title>native tab");
  assert.equal(await tab.evaluate(() => innerWidth), 1600);
  await tab.close();
  await connectClient(client, takeover); // Navigation drops the old RFB socket and reconnects.
  await client.waitForFunction(() => {
    const canvas = document.querySelector("#noVNC_container canvas");
    return window.noVNCUI.connected && canvas.width === 1600 && canvas.height === 900;
  }, null, { timeout: 15000 });
  await client.screenshot({ path: evidence + "/reconnect.png" });
  assert.equal(await desktop.evaluate(() => innerWidth), 1600);
  console.log("PASS new-tab/reconnect");

  await desktop.locator("#typing").fill("automation preserved");
  assert.equal(await desktop.locator("#typing").inputValue(), "automation preserved");
  const dialogSeen = desktop.waitForEvent("dialog");
  const click = desktop.locator("button").click();
  const dialog = await dialogSeen;
  assert.equal(dialog.message(), "42");
  await dialog.dismiss();
  await click;

  // Human takeover must open and cancel the real OS file chooser, not merely a JS alert.
  const chooser = xDisplay ? exec("python", [xCheck, "--dialog"], {
    env: { ...process.env, DISPLAY: xDisplay }, timeout: 15000,
  }) : null;
  await client.evaluate(() => {
    const display = window.noVNCUI.rfb._display;
    window.dialogFrame = new Promise(resolve => {
      const flip = display.flip.bind(display);
      display.flip = (...args) => { flip(...args); display.flip = flip; resolve(); };
    });
    const rfb = window.noVNCUI.rfb;
    rfb.sendKey(0xffe3, "ControlLeft", true);
    rfb.sendKey(0x6f, "KeyO", true);
    rfb.sendKey(0x6f, "KeyO", false);
    rfb.sendKey(0xffe3, "ControlLeft", false);
  });
  await deadline(client.evaluate(() => window.dialogFrame), "native file chooser frame");
  if (chooser) console.log("PASS focused native X dialog", (await chooser).stdout.trim());
  await client.screenshot({ path: evidence + "/native-file-chooser.png" });
  await client.evaluate(() => window.noVNCUI.rfb.sendKey(0xff1b, "Escape"));
  if (xDisplay) await exec("python", [xCheck, "--no-dialog"], {
    env: { ...process.env, DISPLAY: xDisplay }, timeout: 15000,
  });
  await desktop.waitForFunction(() => document.hasFocus(), null, { timeout: 15000 });
  await desktop.locator("#typing").fill("returned from native chooser");
  assert.equal(await desktop.locator("#typing").inputValue(), "returned from native chooser");

  // Cross-origin socket must still be rejected, regardless of VNC password.
  const rejected = await desktop.evaluate(url => new Promise(resolve => {
    const ws = new WebSocket(url);
    ws.onopen = () => { ws.close(); resolve(false); };
    ws.onerror = () => resolve(true);
  }), takeover.replace(/^http/, "ws").replace(/\/vnc.html.*/, "/websockify"));
  assert(rejected, "Origin guard must reject the synthetic data-page origin");
  if (isolated) {
    const owners = new Set();
    for (const pid of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
      const cmd = await readFile("/proc/" + pid + "/cmdline", "utf8").catch(() => "");
      const service = cmd.includes("Xtigervnc") ? "VNC" : cmd.startsWith("fluxbox") ? "WM" :
        cmd.includes("/usr/bin/websockify") ? "noVNC" : cmd.includes("/opt/browser-node/server.mjs") ? "Playwright" :
        cmd.includes("--start-maximized") && cmd.startsWith("/ms-playwright/") ? "Chrome" : null;
      if (!service) continue;
      const status = await readFile("/proc/" + pid + "/status", "utf8");
      assert.equal(Number(status.match(/^Uid:\s+(\d+)/m)[1]), 10001, service + " must be unprivileged");
      const { stdout: env } = await exec("node", ["-e",
        "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
        "/proc/" + pid + "/environ"], { uid: 10001, gid: 10001 });
      assert(!env.split("\0").some(value => value.startsWith("VNC_PASSWORD=")), service + " must not inherit VNC_PASSWORD");
      if (password) assert(!cmd.includes(password), service + " argv must not contain the password");
      owners.add(service);
    }
    assert.deepEqual([...owners].sort(), ["Chrome", "Playwright", "VNC", "WM", "noVNC"].sort());
    console.log("PASS service UID10001 and password isolation");
  }
  if (isolated && password) {
    const file = await stat("/tmp/runtime/vnc-password");
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(file.uid, 10001);
    const denied = await deadline(client.evaluate(async () => {
      const { default: RFB } = await import("./core/rfb.js");
      const container = document.createElement("div");
      document.body.append(container);
      const rfb = new RFB(container, "ws://" + location.host + "/websockify");
      return new Promise(resolve => {
        rfb.addEventListener("credentialsrequired", () => { rfb.disconnect(); resolve(true); }, { once: true });
        rfb.addEventListener("connect", () => { rfb.disconnect(); resolve(false); }, { once: true });
      });
    }), "unauthenticated VNC handshake");
    assert(denied, "password-enabled VNC must not permit an unauthenticated handshake");
  }
  console.log("PASS desktop resize/automation/dialog/Origin" + (password ? "/VNC-auth" : "") + "; next: coordinator review");
} catch (error) {
  console.error("FAIL desktop resize:", error.message, "; next: inspect isolated stack logs");
  if (isolated) for (const name of ["vnc", "fluxbox", "playwright-server", "novnc"]) {
    console.error(name, await readFile("/tmp/" + name + ".log", "utf8").catch(() => "no log"));
  }
  process.exitCode = 1;
} finally {
  // Close our local noVNC client first, then only our synthetic context and
  // Playwright connection. Connected Browser.close() disconnects; it does not
  // stop launchServer or close contexts belonging to other connections.
  for (const [label, resource] of [
    ["local client browser", clientBrowser],
    ["synthetic context", context],
    ["remote Playwright connection", browser],
  ]) {
    if (!resource) continue;
    console.log("CLEANUP start:", label);
    try {
      await deadline(resource.close(), "cleanup " + label);
      console.log("CLEANUP done:", label);
    } catch (error) {
      console.warn("CLEANUP warning:", label, error.message);
    }
  }
  stack?.kill("SIGTERM"); // Only --isolated created this disposable stack.
  // A timed-out Playwright transport can retain Node handles. Exit only this
  // command-line runner after bounded cleanup, never a remote browser server.
  process.exit(process.exitCode || 0);
}
