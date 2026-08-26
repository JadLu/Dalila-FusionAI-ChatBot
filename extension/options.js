const urlInput = document.getElementById("bridge-url");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");

async function loadCurrentUrl() {
  const stored = await chrome.storage.sync.get(FUSION_AI_STORAGE_KEYS.bridgeBaseUrl);
  urlInput.value = stored[FUSION_AI_STORAGE_KEYS.bridgeBaseUrl] || FUSION_AI_DEFAULT_BRIDGE_URL;
}

function normalizeOrigin(rawUrl) {
  const url = new URL(rawUrl); // throws if invalid
  return url.origin;
}

// MV3 requires chrome.permissions.request() to be called synchronously
// within a user-gesture call stack - no awaiting anything beforehand, or
// the browser silently refuses to show the consent prompt.
saveBtn.addEventListener("click", () => {
  statusEl.textContent = "";

  let origin;
  try {
    origin = normalizeOrigin(urlInput.value.trim());
  } catch {
    statusEl.textContent = "Enter a valid URL, e.g. http://localhost:3001";
    return;
  }

  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    if (!granted) {
      statusEl.textContent = "Permission denied - the bridge URL was not saved.";
      return;
    }
    chrome.storage.sync.set({ [FUSION_AI_STORAGE_KEYS.bridgeBaseUrl]: origin }, () => {
      statusEl.textContent = `Saved. The extension will now use ${origin}.`;
    });
  });
});

loadCurrentUrl();

// --- Canvas integration permission ---
const enableCanvasBtn = document.getElementById("enable-canvas");
const canvasStatusEl = document.getElementById("canvas-status");

async function refreshCanvasStatus() {
  const granted = await chrome.permissions.contains({ origins: [`${FUSION_AI_TARGET_ORIGIN}/*`] });
  canvasStatusEl.textContent = granted ? "Enabled." : "Not enabled yet.";
  enableCanvasBtn.disabled = granted;
}

// Same "must be synchronous within a user gesture" constraint as the bridge
// URL's save button above - see its comment.
enableCanvasBtn.addEventListener("click", () => {
  chrome.permissions.request({ origins: [`${FUSION_AI_TARGET_ORIGIN}/*`] }, (granted) => {
    canvasStatusEl.textContent = granted
      ? "Enabled."
      : "Permission denied - Canvas Integration was not enabled.";
    enableCanvasBtn.disabled = granted;
  });
});

refreshCanvasStatus();
