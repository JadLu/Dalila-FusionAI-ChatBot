// In-memory per-session conversation history, stored already in Anthropic
// wire shape ({role, content}) so there's no translation layer at call time.
//
// KNOWN LIMITATION: this is single-process and lost on restart/redeploy - a
// real regression from the old webhook, which owned memory upstream on
// Fusion's platform. This codebase now owns it. Fine for local dev; would
// need a shared store (Redis, a DB) to survive restarts or scale past one process.
const MAX_HISTORY_MESSAGES = 20;

const sessions = new Map();

function getHistory(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  return sessions.get(sessionId);
}

function appendTurn(sessionId, message) {
  const history = getHistory(sessionId);
  history.push(message);
  trimHistory(history);
}

// Trims from the oldest *complete* user-turn segment forward. Never cuts
// between a tool_use message and its matching tool_result message - Anthropic's
// API rejects a request where that pairing is split.
function trimHistory(history) {
  while (history.length > MAX_HISTORY_MESSAGES) {
    // Find the next "user" message after index 0 - that's the start of the
    // next complete turn, so everything before it is safe to drop together.
    let cutIndex = -1;
    for (let i = 1; i < history.length; i++) {
      if (history[i].role === "user") {
        cutIndex = i;
        break;
      }
    }
    if (cutIndex === -1) break; // nothing safe to trim without splitting a pair
    history.splice(0, cutIndex);
  }
}

module.exports = { getHistory, appendTurn };
