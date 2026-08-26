// Tier 0 diagnostic for Kie.ai's Claude proxy - kept for when Kie.ai access is
// unblocked on this account (see project memory: as of 2026-08-23 every model
// tested returns "not authorized to use this model" despite a healthy credit
// balance). The app currently runs on OpenAI directly instead (openAiService.js).
// Usage: node scripts/verify-kie-claude.js
require("dotenv").config();

const fetch = global.fetch || require("node-fetch");

const KIE_BASE_URL = "https://api.kie.ai/claude/v1/messages";

async function callClaude(body) {
  const response = await fetch(KIE_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.KIE_AI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, rawText: text };
}

async function main() {
  const model = process.env.KIE_CLAUDE_MODEL || "claude-opus-5";
  console.log(`Testing Kie.ai Claude proxy with model="${model}"\n`);

  console.log("--- Test 1: basic call (confirms model string + auth work) ---");
  const basic = await callClaude({
    model,
    messages: [{ role: "user", content: "Say hi in exactly 3 words." }],
    stream: false,
    max_tokens: 50,
  });
  console.log("status:", basic.status);
  console.log("body:", basic.rawText.slice(0, 1000));
  console.log();

  if (!basic.ok && !basic.rawText.includes('"content"')) {
    console.log("Basic call failed - if this still says \"not authorized\", the account-wide block described in project memory hasn't lifted yet.");
    process.exit(1);
  }

  console.log('--- Test 2: system prompt support ("always reply only in French") ---');
  const withSystem = await callClaude({
    model,
    system: "You must always respond only in French, no matter what language the user writes in.",
    messages: [{ role: "user", content: "Say hi in exactly 3 words." }],
    stream: false,
    max_tokens: 50,
  });
  console.log("status:", withSystem.status);
  console.log("body:", withSystem.rawText.slice(0, 1000));
}

main().catch((err) => {
  console.error("SCRIPT ERROR:", err);
  process.exit(1);
});
