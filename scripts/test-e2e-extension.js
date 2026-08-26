// Tier 1/2 end-to-end test for the browser extension: builds a temp copy of
// extension/ with manifest.test.json swapped in as manifest.json (widened to
// also match localhost - the real manifest.json stays scoped to the actual
// Fusion platform domain, which this test has no access to), loads it in a
// real Chromium instance via Playwright, and drives a full chat round-trip
// through the real content script + background service worker.
//
// Prereq: the bridge server must already be running on http://localhost:3001
// with real credentials configured.
// Usage: node scripts/test-e2e-extension.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

const EXTENSION_DIR = path.join(__dirname, "..", "extension");

// chrome.storage's LevelDB backend writes deeply-nested paths (e.g.
// Default/Local Extension Settings/<32-char-extension-id>/000003.log) that
// can blow past Windows' 260-char MAX_PATH if rooted under an already-deep
// path (a long OneDrive checkout, a nested AppData\Local\Temp location) -
// this causes chrome.storage calls to hang/fail with a cryptic "LOCK: File
// not found" IO error, not an extension bug. Root test dirs at the shortest
// available prefix instead.
const RUN_ID = Date.now();
const SHORT_ROOT = process.platform === "win32" ? "C:\\" : os.tmpdir();
const TEST_EXT_DIR = path.join(SHORT_ROOT, `fai-ext-build-${RUN_ID}`);
const USER_DATA_DIR = path.join(SHORT_ROOT, `fai-ext-profile-${RUN_ID}`);

function buildTestExtension() {
  fs.mkdirSync(TEST_EXT_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_EXT_DIR, "icons"), { recursive: true });

  const files = [
    "background.js",
    "content.js",
    "shared.js",
    "workflowTransform.js",
    "widget.css",
    "popup.html",
    "popup.js",
    "options.html",
    "options.js",
  ];
  for (const file of files) {
    fs.copyFileSync(path.join(EXTENSION_DIR, file), path.join(TEST_EXT_DIR, file));
  }
  for (const icon of fs.readdirSync(path.join(EXTENSION_DIR, "icons"))) {
    fs.copyFileSync(path.join(EXTENSION_DIR, "icons", icon), path.join(TEST_EXT_DIR, "icons", icon));
  }
  fs.copyFileSync(path.join(EXTENSION_DIR, "manifest.test.json"), path.join(TEST_EXT_DIR, "manifest.json"));
}

function cleanup() {
  fs.rmSync(TEST_EXT_DIR, { recursive: true, force: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
}

async function run() {
  buildTestExtension();

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [`--disable-extensions-except=${TEST_EXT_DIR}`, `--load-extension=${TEST_EXT_DIR}`],
  });

  try {
    await runInner(context);
  } finally {
    await context.close().catch(() => {});
    cleanup();
  }
}

async function runInner(context) {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }
  console.log("Service worker registered:", serviceWorker.url());

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  // Deliberately NOT index.html - it also embeds the <script>-tag widget,
  // which would create its own #fusion-ai-widget-host and collide with the
  // one the extension's content script injects.
  await page.goto("http://localhost:3001/health");

  const host = page.locator("#fusion-ai-widget-host");
  await host.waitFor({ state: "attached", timeout: 10000 });
  console.log("Content script injected the widget host.");

  await host.locator(".fw-toggle").click();

  const input = host.locator(".fw-input");
  const sendBtn = host.locator(".fw-send");
  const messages = host.locator(".fw-messages");

  await input.fill("In one sentence, what is Fusion AI?");
  await sendBtn.click();

  await page.waitForFunction(
    () => {
      const hostEl = document.querySelector("#fusion-ai-widget-host");
      const btn = hostEl?.shadowRoot?.querySelector(".fw-send");
      return btn && !btn.disabled;
    },
    { timeout: 30000 }
  );

  const bubbles = await messages.locator(".fw-msg").allTextContents();
  const lastBubble = bubbles[bubbles.length - 1];
  console.log("Assistant reply:", lastBubble);

  if (bubbles.some((b) => b.includes("Sorry, something went wrong"))) {
    throw new Error("Widget showed an error bubble");
  }
  if (consoleErrors.length) {
    console.log("Console errors:\n" + consoleErrors.join("\n"));
    throw new Error("Console errors were logged");
  }

  console.log("\nPASS - extension loaded, injected the widget, and completed a real chat round-trip.");
}

run().catch((err) => {
  console.error("\nFAIL:", err.message);
  cleanup();
  process.exit(1);
});
