const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { streamAgentResponse } = require("../agent/agentOrchestrator");
const { upload } = require("../middleware/uploadConfig");

const router = express.Router();

// Shared by both /chat and /chat/upload: resolves the session id, opens the
// SSE stream, wires client-disconnect to an AbortController, runs the agent
// loop, and closes the stream. Must only be called after request validation -
// once SSE headers are written, errors can no longer become a plain JSON
// response (see errorHandler.js's res.headersSent check).
async function runChatTurn({ req, res, message, sessionId: incomingSessionId, attachment }) {
  // Reuse the caller's session id (multi-turn memory) or mint a new one.
  const sessionId =
    typeof incomingSessionId === "string" && incomingSessionId.trim() ? incomingSessionId : uuidv4();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // prevent reverse proxies (e.g. nginx) from buffering the stream
  });
  res.flushHeaders?.();

  // Send the session id immediately so the widget can persist it to
  // localStorage even if the upstream call fails before any tokens arrive.
  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

  // Tie the upstream fetch to the client connection so we stop pulling
  // tokens the moment the browser disconnects (tab closed, navigated away).
  // NOTE: `req` (not `res`) emits "close" as soon as the request body has
  // been fully read - which happens immediately, long before the response
  // is done - so it fires on every request and is not a disconnect signal.
  // `res` emits "close" when the connection is terminated, whether that's
  // a normal res.end() or a premature client disconnect; writableEnded
  // tells them apart.
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    await streamAgentResponse({
      message,
      sessionId,
      attachment,
      signal: abortController.signal,
      onToken: (token) => {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
    });

    res.write("data: [DONE]\n\n");
  } catch (error) {
    // Don't treat a client-initiated disconnect as a real error.
    if (error.name !== "AbortError") {
      console.error("[chat] streaming error:", error.message);
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  } finally {
    res.end();
  }
}

// POST /api/chat - accepts { message, sessionId? } and streams the RAG agent's
// reply back to the client as Server-Sent Events.
router.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: '"message" is required and must be a non-empty string' });
  }

  await runChatTurn({ req, res, message, sessionId });
});

// POST /api/chat/upload - multipart form with fields { message?, sessionId?,
// file } - same SSE contract as /chat, but folds a parsed attachment into the
// turn. `message` may be empty as long as a file is attached.
router.post("/chat/upload", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    // Resolve multer's errors (size limit, fileFilter rejection) as plain
    // JSON here - SSE mode hasn't started yet, so this is the last point we
    // can send a normal error response instead of an SSE error frame.
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File is too large." });
    }
    return res.status(400).json({ error: err.message || "File upload failed." });
  });
}, async (req, res) => {
  const { message, sessionId } = req.body || {};
  const hasMessage = typeof message === "string" && message.trim();

  if (!hasMessage && !req.file) {
    return res.status(400).json({ error: 'Either "message" or a "file" is required' });
  }

  await runChatTurn({ req, res, message: hasMessage ? message : "", sessionId, attachment: req.file });
});

module.exports = router;
