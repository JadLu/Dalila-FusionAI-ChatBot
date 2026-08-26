async function checkBridgeHealth() {
  const dot = document.getElementById("bridge-dot");
  const status = document.getElementById("bridge-status");

  const stored = await chrome.storage.sync.get(FUSION_AI_STORAGE_KEYS.bridgeBaseUrl);
  const bridgeBaseUrl = stored[FUSION_AI_STORAGE_KEYS.bridgeBaseUrl] || FUSION_AI_DEFAULT_BRIDGE_URL;

  try {
    const res = await fetch(`${bridgeBaseUrl}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    dot.classList.add("ok");
    status.textContent = `Bridge OK (${bridgeBaseUrl})`;
  } catch (err) {
    dot.classList.add("bad");
    status.textContent = `Bridge unreachable (${bridgeBaseUrl})`;
  }
}

async function checkCurrentPage() {
  const dot = document.getElementById("page-dot");
  const status = document.getElementById("page-status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = "";
  try {
    hostname = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    hostname = "";
  }

  if (hostname === FUSION_AI_TARGET_HOST) {
    dot.classList.add("ok");
    status.textContent = "Widget active on this page";
  } else {
    dot.classList.add("bad");
    status.textContent = `Widget only activates on ${FUSION_AI_TARGET_HOST}`;
  }
}

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

checkBridgeHealth();
checkCurrentPage();
