// Shared constants across every extension context (background, content,
// popup, options) - loaded via a plain <script>/importScripts, not a module,
// so these attach to the global scope in each context that includes this file.
const FUSION_AI_PORT_NAME = "fusion-ai-chat";

const FUSION_AI_STORAGE_KEYS = {
  bridgeBaseUrl: "bridgeBaseUrl",
  sessionId: "sessionId",
};

const FUSION_AI_DEFAULT_BRIDGE_URL = "http://localhost:3001";

// Must match manifest.json's content_scripts.matches host - duplicated here
// since JSON can't reference JS constants. Used by popup.js to report whether
// the current tab is a page the content script actually activates on.
const FUSION_AI_TARGET_HOST = "stg-orch.abafusion.ai";
// The platform's own origin - background.js calls its /api/graphs/:id
// endpoint directly (same-origin as the canvas page, cookie-authenticated),
// and options.js requests this as an optional host permission before that's
// allowed to happen.
const FUSION_AI_TARGET_ORIGIN = `https://${FUSION_AI_TARGET_HOST}`;
