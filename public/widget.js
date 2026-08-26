/**
 * Fusion AI embeddable floating chat widget.
 *
 * Drop this on any page with:
 *   <script src="http://localhost:3001/widget.js" defer></script>
 *
 * The widget builds its UI inside a Shadow DOM so its styles can never leak
 * into (or be clobbered by) the host page's CSS.
 */
(function () {
  "use strict";

  // Prevent double-initialization if the script tag is accidentally included twice.
  if (window.__fusionAiWidgetLoaded) return;
  window.__fusionAiWidgetLoaded = true;

  const SESSION_STORAGE_KEY = "chat_session_id";

  // Resolve the API origin from this script's own <script src>, so the
  // widget works correctly no matter which host page it's embedded on.
  const currentScript =
    document.currentScript ||
    (function findSelf() {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();
  const API_BASE = new URL(currentScript.src, window.location.href).origin;

  function generateUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    // RFC4122-ish fallback for older browsers without crypto.randomUUID.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  let sessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId) {
    sessionId = generateUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }

  // Kept in sync by hand with uploadConfig.js's ALLOWED_EXTENSIONS / MAX_UPLOAD_BYTES -
  // this is a UX nicety (fail fast before a network round-trip); the server
  // enforces the real limits regardless.
  const ALLOWED_FILE_EXTENSIONS = [".pdf", ".json", ".xml", ".bpmn", ".png", ".jpg", ".jpeg"];
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // Generous enough for a real attachment turn (observed up to ~75s for a
  // full workflow-JSON generation) with headroom, while guaranteeing the UI
  // can never be stuck showing "typing..." forever if the backend hangs.
  const TURN_TIMEOUT_MS = 120000;

  const ICONS = {
    chat: `<svg class="fw-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
    close: `<svg class="fw-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    closeSmall: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    attach: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  };

  function buildWidgetMarkup() {
    return `
      <link rel="stylesheet" href="${API_BASE}/widget.css">
      <div class="fusion-widget" id="fw-root">
        <div class="fw-window" role="dialog" aria-label="Dalila chat" aria-hidden="true">
          <div class="fw-header">
            <div>
              <div class="fw-header-title">Dalila</div>
              <div class="fw-header-subtitle"><span class="fw-status-dot"></span>Online</div>
            </div>
            <button class="fw-header-close" type="button" aria-label="Close chat">${ICONS.closeSmall}</button>
          </div>
          <div class="fw-messages" id="fw-messages"></div>
          <div class="fw-attachment-chip" id="fw-attachment-chip" hidden>
            <span class="fw-attachment-name"></span>
            <button class="fw-attachment-remove" type="button" aria-label="Remove attachment">${ICONS.closeSmall}</button>
          </div>
          <div class="fw-input-bar">
            <input class="fw-file-input" type="file" accept="${ALLOWED_FILE_EXTENSIONS.join(",")}" hidden />
            <button class="fw-attach" type="button" aria-label="Attach a file">${ICONS.attach}</button>
            <textarea class="fw-input" rows="1" placeholder="Type a message..." aria-label="Message"></textarea>
            <button class="fw-send" type="button" aria-label="Send message">${ICONS.send}</button>
          </div>
        </div>
        <button class="fw-toggle" type="button" aria-label="Open chat">
          ${ICONS.chat}
          ${ICONS.close}
        </button>
      </div>
    `;
  }

  function init() {
    const host = document.createElement("div");
    host.id = "fusion-ai-widget-host";
    document.body.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = buildWidgetMarkup();

    const root = shadowRoot.getElementById("fw-root");
    const toggleBtn = shadowRoot.querySelector(".fw-toggle");
    const closeBtn = shadowRoot.querySelector(".fw-header-close");
    const windowEl = shadowRoot.querySelector(".fw-window");
    const messagesEl = shadowRoot.getElementById("fw-messages");
    const inputEl = shadowRoot.querySelector(".fw-input");
    const sendBtn = shadowRoot.querySelector(".fw-send");
    const attachBtn = shadowRoot.querySelector(".fw-attach");
    const fileInputEl = shadowRoot.querySelector(".fw-file-input");
    const chipEl = shadowRoot.getElementById("fw-attachment-chip");
    const chipNameEl = chipEl.querySelector(".fw-attachment-name");
    const chipRemoveBtn = chipEl.querySelector(".fw-attachment-remove");

    let isOpen = false;
    let isSending = false;
    let pendingFile = null;

    // --- Open / close ---
    function setOpen(open) {
      isOpen = open;
      root.classList.toggle("fw-open", open);
      toggleBtn.setAttribute("aria-label", open ? "Close chat" : "Open chat");
      windowEl.setAttribute("aria-hidden", String(!open));
      if (open) {
        // Wait for the open transition to start before stealing focus.
        setTimeout(() => inputEl.focus(), 50);
      }
    }

    toggleBtn.addEventListener("click", () => setOpen(!isOpen));
    closeBtn.addEventListener("click", () => setOpen(false));
    shadowRoot.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) setOpen(false);
    });

    // --- Message rendering ---
    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessage(role, text) {
      const bubble = document.createElement("div");
      bubble.className = `fw-msg fw-${role}`;
      bubble.textContent = text; // textContent only - never render model output as HTML
      messagesEl.appendChild(bubble);
      scrollToBottom();
      return bubble;
    }

    function renderTyping() {
      const typing = document.createElement("span");
      typing.className = "fw-typing";
      typing.innerHTML = "<span></span><span></span><span></span>";
      return typing;
    }

    appendMessage("assistant", "Hi! I'm Dalila. How can I help you today?");

    // --- Attachments ---
    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function getExtension(filename) {
      const dot = filename.lastIndexOf(".");
      return dot === -1 ? "" : filename.slice(dot).toLowerCase();
    }

    function clearAttachment() {
      pendingFile = null;
      chipEl.hidden = true;
      fileInputEl.value = "";
    }

    function handleFileSelected(file) {
      if (!file) return;

      if (!ALLOWED_FILE_EXTENSIONS.includes(getExtension(file.name))) {
        appendMessage("error", `"${file.name}" isn't a supported file type. Allowed: ${ALLOWED_FILE_EXTENSIONS.join(", ")}`);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        appendMessage("error", `"${file.name}" is too large (max ${formatBytes(MAX_UPLOAD_BYTES)}).`);
        return;
      }

      pendingFile = file;
      chipNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
      chipEl.hidden = false;
    }

    attachBtn.addEventListener("click", () => fileInputEl.click());
    fileInputEl.addEventListener("change", () => handleFileSelected(fileInputEl.files[0]));
    chipRemoveBtn.addEventListener("click", clearAttachment);

    windowEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      windowEl.classList.add("fw-dragover");
    });
    windowEl.addEventListener("dragleave", (e) => {
      if (e.target === windowEl) windowEl.classList.remove("fw-dragover");
    });
    windowEl.addEventListener("drop", (e) => {
      e.preventDefault();
      windowEl.classList.remove("fw-dragover");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFileSelected(file);
    });

    // --- Input handling ---
    function autoResizeInput() {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
    }
    inputEl.addEventListener("input", autoResizeInput);

    function setSending(sending) {
      isSending = sending;
      sendBtn.disabled = sending;
      inputEl.disabled = sending;
    }

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });
    sendBtn.addEventListener("click", () => sendMessage(inputEl.value));

    // --- Streaming chat request ---
    async function sendMessage(rawText) {
      const text = rawText.trim();
      const file = pendingFile;
      if ((!text && !file) || isSending) return;

      appendMessage("user", file ? `${text}\n📎 ${file.name}` : text);
      inputEl.value = "";
      autoResizeInput();
      clearAttachment();
      setSending(true);

      const assistantBubble = appendMessage("assistant", "");
      assistantBubble.classList.add("fw-empty");
      const typingEl = renderTyping();
      assistantBubble.appendChild(typingEl);
      scrollToBottom();

      let assistantText = "";
      let firstTokenReceived = false;

      const clearTyping = () => {
        if (typingEl.parentNode) typingEl.remove();
        assistantBubble.classList.remove("fw-empty");
      };

      // Parses one "data: ..." SSE frame and updates UI/session state accordingly.
      const handleEventBlock = (eventBlock) => {
        const dataLines = eventBlock
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) return;

        const payload = dataLines.join("\n");
        if (payload === "[DONE]") {
          clearTyping();
          return;
        }

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          return; // ignore malformed / non-JSON frames
        }

        if (typeof json.sessionId === "string") {
          sessionId = json.sessionId;
          localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
          return;
        }

        if (typeof json.error === "string") {
          clearTyping();
          assistantBubble.classList.add("fw-error");
          assistantBubble.textContent = json.error;
          return;
        }

        if (typeof json.token === "string") {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            clearTyping();
          }
          assistantText += json.token;
          assistantBubble.textContent = assistantText;
          scrollToBottom();
        }
      };

      // Guarantees the UI can't get stuck showing "typing..." forever if the
      // backend hangs (e.g. a stalled upstream LLM call with no timeout of
      // its own) - aborts the fetch/stream, which the catch below turns into
      // the normal error bubble.
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), TURN_TIMEOUT_MS);

      try {
        let response;
        if (file) {
          const formData = new FormData();
          formData.append("message", text);
          formData.append("sessionId", sessionId);
          formData.append("file", file);
          // No explicit Content-Type - the browser must set the multipart
          // boundary itself, otherwise the server can't parse the body.
          response = await fetch(`${API_BASE}/api/chat/upload`, {
            method: "POST",
            body: formData,
            signal: timeoutController.signal,
          });
        } else {
          response = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, sessionId }),
            signal: timeoutController.signal,
          });
        }

        if (!response.ok || !response.body) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            handleEventBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        clearTyping();
        if (!assistantText) assistantBubble.remove();
        const message = err.name === "AbortError" ? "That's taking too long - please try again." : "Sorry, something went wrong. Please try again.";
        appendMessage("error", message);
        console.error("[Fusion AI Widget]", err);
      } finally {
        clearTimeout(timeoutId);
        setSending(false);
        inputEl.focus();
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
