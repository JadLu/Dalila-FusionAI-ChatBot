const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const pdfParse = require("pdf-parse");

// Character-based cap on extracted text folded into the model's context per
// attachment. This is a heuristic guard against blowing the context window,
// not a token-exact budget - openAiService.js's max_completion_tokens only
// caps *output* tokens, so this is the only real guard on attachment input size.
const MAX_ATTACHMENT_CHARS = Number(process.env.MAX_ATTACHMENT_CHARS) || 12000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function truncate(text) {
  if (text.length <= MAX_ATTACHMENT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_ATTACHMENT_CHARS)}\n\n... [truncated, showing ${MAX_ATTACHMENT_CHARS} of ${text.length} characters]`,
    truncated: true,
  };
}

function parseJson(buffer) {
  const raw = buffer.toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return `(not valid JSON - showing raw content)\n${raw}`;
  }
}

// Recursively collects BPMN-shaped elements from a parsed XML object,
// tolerant of bpmn:/bpmn2: namespace prefixes (fast-xml-parser keeps prefixes
// in tag names by default, e.g. "bpmn:task").
function collectBpmnElements(node, bucket, key) {
  if (node == null || typeof node !== "object") return;

  for (const [tagName, value] of Object.entries(node)) {
    const localName = tagName.includes(":") ? tagName.split(":").pop() : tagName;
    const values = Array.isArray(value) ? value : [value];

    if (localName === key) {
      for (const v of values) {
        if (v && typeof v === "object") {
          bucket.push({
            id: v["@_id"],
            name: v["@_name"],
            sourceRef: v["@_sourceRef"],
            targetRef: v["@_targetRef"],
          });
        }
      }
    }

    for (const v of values) {
      if (v && typeof v === "object") collectBpmnElements(v, bucket, key);
    }
  }
}

function extractBpmnSummary(parsedXml) {
  const processes = [];
  const tasks = [];
  const events = [];
  const gateways = [];
  const sequenceFlows = [];

  collectBpmnElements(parsedXml, processes, "process");
  for (const taskTag of ["task", "userTask", "serviceTask", "scriptTask", "manualTask"]) {
    collectBpmnElements(parsedXml, tasks, taskTag);
  }
  for (const eventTag of ["startEvent", "endEvent", "intermediateThrowEvent", "intermediateCatchEvent"]) {
    collectBpmnElements(parsedXml, events, eventTag);
  }
  for (const gatewayTag of ["exclusiveGateway", "parallelGateway", "inclusiveGateway"]) {
    collectBpmnElements(parsedXml, gateways, gatewayTag);
  }
  collectBpmnElements(parsedXml, sequenceFlows, "sequenceFlow");

  const hasBpmnContent =
    processes.length + tasks.length + events.length + gateways.length + sequenceFlows.length > 0;

  return { hasBpmnContent, summary: { processes, tasks, events, gateways, sequenceFlows } };
}

function parseXmlOrBpmn(buffer) {
  const raw = buffer.toString("utf8");
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsedXml = parser.parse(raw);
    const { hasBpmnContent, summary } = extractBpmnSummary(parsedXml);
    if (hasBpmnContent) {
      return `(BPMN elements extracted from the uploaded XML)\n${JSON.stringify(summary, null, 2)}`;
    }
    // Valid XML, but nothing BPMN-shaped in it - fall back to the raw text
    // so the model still sees whatever structure the file actually has.
    return `(XML without recognizable BPMN elements - showing raw content)\n${raw}`;
  } catch {
    return `(could not parse as XML - showing raw content)\n${raw}`;
  }
}

async function parsePdf(buffer) {
  try {
    const { text } = await pdfParse(buffer);
    if (!text || !text.trim()) {
      return "(no extractable text found in this PDF - it may be a scanned/image-only document, which this parser cannot OCR)";
    }
    return text;
  } catch (error) {
    return `(failed to extract text from this PDF: ${error.message})`;
  }
}

/**
 * Normalizes an uploaded file into either text to fold into the user's
 * message, or an image data URI for a multimodal message. Never throws for
 * "couldn't fully parse this file" cases - those degrade gracefully in-band
 * so one bad attachment doesn't fail the whole chat turn.
 *
 * @param {{buffer: Buffer, originalname: string, mimetype: string, size: number}} file
 * @returns {Promise<{mode: "text", text: string, truncated: boolean} | {mode: "image", dataUri: string, mimetype: string}>}
 */
async function parseAttachment(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    const mimetype = file.mimetype && file.mimetype.startsWith("image/") ? file.mimetype : "image/png";
    const dataUri = `data:${mimetype};base64,${file.buffer.toString("base64")}`;
    return { mode: "image", dataUri, mimetype };
  }

  let text;
  if (ext === ".json") {
    text = parseJson(file.buffer);
  } else if (ext === ".xml" || ext === ".bpmn") {
    text = parseXmlOrBpmn(file.buffer);
  } else if (ext === ".pdf") {
    text = await parsePdf(file.buffer);
  } else {
    text = file.buffer.toString("utf8");
  }

  const { text: truncatedText, truncated } = truncate(text);
  return { mode: "text", text: truncatedText, truncated };
}

module.exports = { parseAttachment, MAX_ATTACHMENT_CHARS };
