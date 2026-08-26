/**
 * Fusion AI chat widget - browser extension content script.
 *
 * Adapted from public/widget.js: the UI (Shadow DOM, markup, bubble
 * rendering, input handling) is reused near-verbatim; the transport is
 * rewritten around a chrome.runtime Port to the background service worker,
 * since a content script's own fetch() is subject to the host page's
 * CSP/CORS while the background worker is exempt.
 */
(function () {
  "use strict";

  if (window.__fusionAiWidgetLoaded) return;
  window.__fusionAiWidgetLoaded = true;

  function generateUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Extension-scoped storage, not the host page's own localStorage - the
  // Fusion platform's own JS can't read, clash with, or clear this.
  let sessionId = null;
  async function ensureSessionId() {
    if (sessionId) return sessionId;
    const stored = await chrome.storage.local.get(FUSION_AI_STORAGE_KEYS.sessionId);
    sessionId = stored[FUSION_AI_STORAGE_KEYS.sessionId];
    if (!sessionId) {
      sessionId = generateUUID();
      await chrome.storage.local.set({ [FUSION_AI_STORAGE_KEYS.sessionId]: sessionId });
    }
    return sessionId;
  }

  // --- Port connection to the background service worker ---
  // A fresh connection per operation, not a long-lived one reused across
  // turns: the MV3 service worker can be torn down for inactivity between
  // turns (it terminates after ~30s idle, and a chat turn can easily leave
  // a longer gap than that before the next one), and calling
  // postMessage() on an already-disconnected Port throws synchronously.
  // That throw was uncaught here, silently leaving isSending stuck true
  // forever - the widget just spins with no error and no way to send
  // another message. chrome.runtime.connect() itself always succeeds
  // (it wakes the service worker on demand), so there's no real cost to
  // reconnecting every time.
  function openPort() {
    return chrome.runtime.connect({ name: FUSION_AI_PORT_NAME });
  }

  // Kept in sync by hand with the bridge's uploadConfig.js (ALLOWED_EXTENSIONS /
  // MAX_UPLOAD_BYTES) - a UX nicety (fail fast before round-tripping through
  // the background worker); the server enforces the real limits regardless.
  const ALLOWED_FILE_EXTENSIONS = [".pdf", ".json", ".xml", ".bpmn", ".png", ".jpg", ".jpeg"];
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // Generous enough to cover a real attachment turn (observed up to ~75s for
  // a full workflow-JSON generation) with headroom, while still guaranteeing
  // the UI can never be stuck showing "typing..." forever - whatever the
  // cause (a hung upstream call, a dropped connection that somehow didn't
  // fire onDisconnect, etc.), the user always gets their send button back.
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
      <link rel="stylesheet" href="${chrome.runtime.getURL("widget.css")}">
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

  // The canvas doesn't live-refresh when an external request (like our
  // background worker's PATCH) changes the graph - confirmed a manual page
  // reload picks it up correctly, so "Send to Canvas" success triggers one
  // automatically. That would normally reset the visible chat (a fresh
  // content script load), so the transcript + open/closed state round-trip
  // through sessionStorage across that one reload.
  const CHAT_RESTORE_KEY = "fusionAiChatRestore";

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

    function saveChatRestoreState() {
      const messages = [...messagesEl.querySelectorAll(".fw-msg")].map((el) => {
        const roleClass = [...el.classList].find((c) => c !== "fw-msg" && c.startsWith("fw-"));
        return { role: roleClass ? roleClass.slice(3) : "assistant", text: el.textContent };
      });
      sessionStorage.setItem(CHAT_RESTORE_KEY, JSON.stringify({ messages, isOpen }));
    }

    function restoreChatState() {
      const raw = sessionStorage.getItem(CHAT_RESTORE_KEY);
      if (!raw) return false;
      sessionStorage.removeItem(CHAT_RESTORE_KEY);
      let saved;
      try {
        saved = JSON.parse(raw);
      } catch {
        return false;
      }
      for (const m of saved.messages || []) appendMessage(m.role, m.text);
      if (saved.isOpen) setOpen(true);
      return true;
    }

    if (!restoreChatState()) {
      appendMessage("assistant", "Hi! I'm Dalila. How can I help you today?");
    }

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

    // Reads a file as a base64 data URL (a plain string) rather than an
    // ArrayBuffer - chrome.runtime.Port.postMessage does not reliably
    // preserve a raw ArrayBuffer's bytes for binary files (confirmed: real
    // PDFs arrived corrupted server-side despite this "should" be
    // structured-cloneable); a string round-trips intact.
    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    // --- Send to Canvas ---
    // Sends a request over the port and resolves once a message with one of
    // responseTypes arrives - a one-shot counterpart to the streaming
    // handleMessage/finish pattern sendMessage uses for chat turns.
    function sendPortRequest(requestMsg, responseTypes) {
      return new Promise((resolve) => {
        const activePort = openPort();
        const handler = (msg) => {
          if (responseTypes.includes(msg.type)) {
            activePort.onMessage.removeListener(handler);
            resolve(msg);
          }
        };
        activePort.onMessage.addListener(handler);
        try {
          activePort.postMessage(requestMsg);
        } catch (err) {
          console.error("[Fusion AI Widget] port request failed:", err);
          resolve({ error: err.message || "Request failed" });
        }
      });
    }

    // Extracts a fenced ```json block from the assistant's reply and returns
    // it only if it's plausibly a workflow (has a nodes array) - avoids
    // offering "Send to Canvas" on an ordinary code snippet in a reply.
    function extractWorkflowJson(text) {
      const match = text.match(/```json\n([\s\S]*?)```/);
      if (!match) return null;
      try {
        const parsed = JSON.parse(match[1]);
        return Array.isArray(parsed.nodes) ? parsed : null;
      } catch {
        return null;
      }
    }

    function getCurrentGraphId() {
      const match = window.location.pathname.match(/\/automation\/([a-zA-Z0-9]+)/);
      return match ? match[1] : null;
    }

    function renderCanvasButton(afterEl, workflow) {
      const btn = document.createElement("button");
      btn.className = "fw-canvas-btn";
      btn.type = "button";
      btn.textContent = "📤 Send to Canvas";
      afterEl.insertAdjacentElement("afterend", btn);
      scrollToBottom();

      btn.addEventListener("click", async () => {
        const graphId = getCurrentGraphId();
        if (!graphId) {
          appendMessage("error", "Open a workflow in the canvas first, then click Send to Canvas.");
          return;
        }
        const confirmed = window.confirm(
          "This replaces the current canvas's nodes and connections with the generated workflow. Continue?"
        );
        if (!confirmed) return;

        btn.disabled = true;
        btn.textContent = "Sending…";

        const permStatus = await sendPortRequest({ type: "checkCanvasPermission" }, ["canvasPermissionStatus"]);
        if (!permStatus.granted) {
          btn.disabled = false;
          btn.textContent = "📤 Send to Canvas";
          const notice = appendMessage(
            "error",
            "Canvas integration isn't enabled yet. Open the extension's settings and enable it, then try again."
          );
          const openSettingsBtn = document.createElement("button");
          openSettingsBtn.className = "fw-canvas-btn";
          openSettingsBtn.type = "button";
          openSettingsBtn.textContent = "Open Extension Settings";
          openSettingsBtn.addEventListener("click", () => openPort().postMessage({ type: "openOptionsPage" }));
          notice.insertAdjacentElement("afterend", openSettingsBtn);
          scrollToBottom();
          return;
        }

        const result = await sendPortRequest({ type: "sendToCanvas", graphId, workflow }, ["canvasUpdateResult"]);
        if (result.success) {
          btn.textContent = `✓ Sent to Canvas (${result.nodeCount} node${result.nodeCount === 1 ? "" : "s"})`;
          // The canvas only picks up an externally-applied change on load, not
          // live - reload so it appears immediately, preserving the visible
          // chat (and that this button now shows "Sent") across the reload.
          saveChatRestoreState();
          setTimeout(() => window.location.reload(), 400);
        } else {
          btn.disabled = false;
          btn.textContent = "📤 Send to Canvas";
          appendMessage("error", result.error || "Sending to canvas failed.");
        }
      });
    }

    // --- Port-based chat request ---
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
      let settled = false;

      const clearTyping = () => {
        if (typingEl.parentNode) typingEl.remove();
        assistantBubble.classList.remove("fw-empty");
      };

      const activePort = openPort();

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        activePort.onMessage.removeListener(handleMessage);
        activePort.onDisconnect.removeListener(handleDisconnect);
        setSending(false);
        inputEl.focus();
      };

      const handleMessage = (msg) => {
        if (msg.type === "sessionId") {
          sessionId = msg.sessionId;
          chrome.storage.local.set({ [FUSION_AI_STORAGE_KEYS.sessionId]: sessionId });
          return;
        }
        if (msg.type === "error") {
          clearTyping();
          assistantBubble.classList.add("fw-error");
          assistantBubble.textContent = msg.error;
          finish();
          return;
        }
        if (msg.type === "token") {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            clearTyping();
          }
          assistantText += msg.token;
          assistantBubble.textContent = assistantText;
          scrollToBottom();
          return;
        }
        if (msg.type === "done") {
          clearTyping();
          const workflow = extractWorkflowJson(assistantText);
          if (workflow) renderCanvasButton(assistantBubble, workflow);
          finish();
        }
      };

      // The background worker can be terminated/reloaded mid-turn; without
      // this, a dropped port would leave the UI stuck in "sending" forever.
      const handleDisconnect = () => {
        if (settled) return;
        clearTyping();
        if (!assistantText) assistantBubble.remove();
        appendMessage("error", "Sorry, something went wrong. Please try again.");
        finish();
      };

      activePort.onMessage.addListener(handleMessage);
      activePort.onDisconnect.addListener(handleDisconnect);

      const timeoutId = setTimeout(() => {
        if (settled) return;
        clearTyping();
        if (!assistantText) assistantBubble.remove();
        appendMessage("error", "That's taking too long - please try again.");
        finish();
      }, TURN_TIMEOUT_MS);

      try {
        const sid = await ensureSessionId();

        // content.js can't fetch() the bridge itself (CSP/CORS - see file
        // header), so a file is handed to the background worker as a base64
        // data URL string over the port; the worker builds the actual
        // multipart request. See fileToDataUrl's comment for why a string,
        // not an ArrayBuffer.
        let attachment;
        if (file) {
          attachment = { name: file.name, mimetype: file.type, dataUrl: await fileToDataUrl(file) };
        }

        activePort.postMessage({ type: "send", message: text, sessionId: sid, attachment });
      } catch (err) {
        // e.g. postMessage on an already-disconnected port, or a
        // FileReader failure - without this, isSending would stay true
        // forever with no way to send another message.
        console.error("[Fusion AI Widget] failed to send:", err);
        handleDisconnect();
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
