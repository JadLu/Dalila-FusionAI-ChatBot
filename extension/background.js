// MV3 service worker - the only extension context that ever calls fetch().
// Content scripts are subject to the host page's CSP/CORS; this background
// worker is exempt (with host_permissions covering the bridge origin), so
// all network access to the bridge is funneled through here and relayed to
// content.js over a long-lived Port.
importScripts("shared.js", "workflowTransform.js");

async function getBridgeBaseUrl() {
  const stored = await chrome.storage.sync.get(FUSION_AI_STORAGE_KEYS.bridgeBaseUrl);
  return stored[FUSION_AI_STORAGE_KEYS.bridgeBaseUrl] || FUSION_AI_DEFAULT_BRIDGE_URL;
}

// Parses one "data: ..." SSE frame - same logic as public/widget.js's
// handleEventBlock, just posting to a Port instead of touching the DOM.
function parseEventBlock(eventBlock) {
  const dataLines = eventBlock
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return null;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return { type: "done" };

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return null; // ignore malformed / non-JSON frames
  }

  if (typeof json.sessionId === "string") return { type: "sessionId", sessionId: json.sessionId };
  if (typeof json.error === "string") return { type: "error", error: json.error };
  if (typeof json.token === "string") return { type: "token", token: json.token };
  return null;
}

async function handleSend(port, { message, sessionId, attachment }, signal) {
  const bridgeBaseUrl = await getBridgeBaseUrl();

  try {
    let response;
    if (attachment) {
      // attachment.dataUrl is a "data:mime;base64,..." string - content.js
      // can't fetch() the bridge itself (CSP/CORS), so it hands the file
      // over the port this way (a raw ArrayBuffer does NOT survive the port
      // intact for binary files - see content.js's fileToDataUrl comment)
      // and this worker does the actual multipart upload. fetch() can
      // decode a data: URL directly into a correctly-typed Blob.
      const blob = await (await fetch(attachment.dataUrl)).blob();
      const formData = new FormData();
      formData.append("message", message);
      formData.append("sessionId", sessionId);
      formData.append("file", blob, attachment.name);
      response = await fetch(`${bridgeBaseUrl}/api/chat/upload`, { method: "POST", body: formData, signal });
    } else {
      response = await fetch(`${bridgeBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
        signal,
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
        const event = parseEventBlock(buffer.slice(0, boundary));
        if (event) port.postMessage(event);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      port.postMessage({ type: "error", error: err.message || "Request failed" });
    }
  }
}

async function handleCheckCanvasPermission(port) {
  const granted = await chrome.permissions.contains({ origins: [`${FUSION_AI_TARGET_ORIGIN}/*`] });
  port.postMessage({ type: "canvasPermissionStatus", granted });
}

// Replaces the currently-open canvas workflow's nodes/connections with the
// chatbot-generated ones. GETs the existing graph first because the PATCH
// endpoint expects id/userId/version/createdAt back (they belong to the
// existing graph, not something to invent) and because nodes/connections are
// fully replaced, not merged - preserving the rest of the existing graph's
// metadata is the least surprising behavior for whatever isn't being changed.
async function handleSendToCanvas(port, { graphId, workflow }) {
  try {
    const granted = await chrome.permissions.contains({ origins: [`${FUSION_AI_TARGET_ORIGIN}/*`] });
    if (!granted) {
      port.postMessage({
        type: "canvasUpdateResult",
        success: false,
        error: "Canvas integration isn't enabled yet - open the extension's options page and enable it first.",
      });
      return;
    }

    const getRes = await fetch(`${FUSION_AI_TARGET_ORIGIN}/api/graphs/${graphId}`, { credentials: "include" });
    if (!getRes.ok) throw new Error(`Could not load the current workflow (status ${getRes.status})`);
    const current = await getRes.json();

    const { nodes, connections } = transformWorkflowForCanvas(workflow);

    const patchBody = {
      name: workflow.name || current.name,
      nodes,
      connections,
      status: current.status || "stopped",
      tracingEnabled: current.tracingEnabled !== undefined ? current.tracingEnabled : true,
      userId: current.userId,
      id: current.id,
      version: current.version,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      publishedNames: current.publishedNames || [],
    };

    const patchRes = await fetch(`${FUSION_AI_TARGET_ORIGIN}/api/graphs/${graphId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) throw new Error(`Canvas update failed (status ${patchRes.status})`);

    const updated = await patchRes.json();
    port.postMessage({ type: "canvasUpdateResult", success: true, nodeCount: (updated.nodes || []).length });
  } catch (err) {
    port.postMessage({ type: "canvasUpdateResult", success: false, error: err.message || "Canvas update failed" });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FUSION_AI_PORT_NAME) return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener((msg) => {
    if (msg?.type === "send") {
      handleSend(port, msg, controller.signal);
    } else if (msg?.type === "checkCanvasPermission") {
      handleCheckCanvasPermission(port);
    } else if (msg?.type === "sendToCanvas") {
      handleSendToCanvas(port, msg);
    } else if (msg?.type === "openOptionsPage") {
      // chrome.runtime.openOptionsPage() isn't available to content scripts
      // (same restriction as chrome.permissions.*) - only extension pages,
      // including this background worker, can call it.
      chrome.runtime.openOptionsPage();
    }
  });
});
