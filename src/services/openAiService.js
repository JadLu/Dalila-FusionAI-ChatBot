// Thin fetch client for OpenAI's real Chat Completions API - the primary LLM
// while Kie.ai's Claude/GPT access remains account-blocked (see project memory).
// Empirically verified against this account before building on it:
//  - gpt-5.6-terra requires max_completion_tokens, not the legacy max_tokens.
//  - Function tools require reasoning_effort:"none" on /v1/chat/completions for
//    this model - OpenAI's own error says otherwise use /v1/responses instead.
const fetch = global.fetch || require("node-fetch");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * @param {Object} params
 * @param {Array}  params.messages - OpenAI-shaped messages (system/user/assistant/tool roles)
 * @param {Array}  [params.tools] - OpenAI-shaped tool definitions ({type:"function", function:{...}})
 * @param {number} [params.maxTokens]
 * @param {string} [params.reasoningEffort] - overrides the tools-triggered default below (e.g. "none")
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} the raw OpenAI chat.completion response body
 */
async function createChatCompletion({ messages, tools, maxTokens = 4096, reasoningEffort, signal }) {
  const { OPENAI_API_KEY, OPENAI_CHAT_MODEL } = process.env;

  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the server");
  }

  const body = {
    model: OPENAI_CHAT_MODEL || "gpt-5.6-terra",
    messages,
    max_completion_tokens: maxTokens,
  };
  if (tools && tools.length) {
    body.tools = tools;
    // Required alongside tools on this endpoint for this model family - see
    // header comment. Trades away extra reasoning depth for tool-calling
    // support without needing the more complex /v1/responses API.
    body.reasoning_effort = "none";
  }
  // Explicit override wins either way - e.g. attachment turns force "none"
  // even without tools, because this model spends *reasoning* tokens out of
  // the same max_completion_tokens budget as its visible output. Left
  // unconstrained, reasoning can consume the entire budget and leave zero
  // tokens for the actual answer (finish_reason "length", empty content) -
  // confirmed empirically against this account on a real multi-node workflow
  // generation (reasoning_tokens hit the full cap, content was "").
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const rawText = await response.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`OpenAI API returned non-JSON (${response.status}): ${rawText.slice(0, 300)}`);
  }

  if (!response.ok) {
    const message = json?.error?.message || rawText.slice(0, 300);
    throw new Error(`OpenAI API responded with ${response.status}: ${message}`);
  }

  return json;
}

module.exports = { createChatCompletion };
