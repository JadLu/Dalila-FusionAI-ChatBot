// Tier 1 end-to-end test: drives the real widget UI in a real (headless)
// browser against the running bridge server, exercising the full path -
// Shadow DOM widget -> fetch -> SSE -> RAG retrieval -> LLM -> tool loop.
// Prereq: the bridge server must already be running on http://localhost:3001
// with real credentials configured.
// Usage: node scripts/test-e2e-widget.js
const { chromium } = require("playwright");

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  await page.goto("http://localhost:3001/index.html");

  const host = page.locator("#fusion-ai-widget-host");
  await host.waitFor({ state: "attached" });
  await host.locator(".fw-toggle").click();

  const input = host.locator(".fw-input");
  const sendBtn = host.locator(".fw-send");
  const messages = host.locator(".fw-messages");

  async function send(text, label) {
    await input.fill(text);
    await sendBtn.click();
    // Wait for the assistant bubble to stop being empty/typing and for the
    // send button to re-enable (turn complete).
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
    console.log(`\n[${label}] user: "${text}"`);
    console.log(`[${label}] assistant: "${lastBubble}"`);
    if (bubbles.some((b) => b.includes("Sorry, something went wrong"))) {
      throw new Error(`[${label}] widget showed an error bubble`);
    }
    return lastBubble;
  }

  await send("In one sentence, what is Fusion AI?", "benign question");
  await send("Create a trigger node called Smoke Test Node.", "tool-triggering question");

  if (consoleErrors.length) {
    console.log("\nConsole errors captured:\n" + consoleErrors.join("\n"));
    throw new Error("Console errors were logged during the test run");
  }

  console.log("\nPASS - both turns completed with no error bubbles and no console errors.");
  await browser.close();
}

run().catch((err) => {
  console.error("\nFAIL:", err.message);
  process.exit(1);
});
