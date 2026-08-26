const openAiService = require("../services/openAiService");
const pineconeService = require("../services/pineconeService");
const conversationStore = require("./conversationStore");
const { TOOL_DEFINITIONS, executeTool } = require("./tools");
const { parseAttachment } = require("./attachments/parseAttachment");
const { WORKFLOW_SCHEMA_PROMPT } = require("./workflowSchemaPrompt");

const MAX_TOOL_ITERATIONS = 5;
const TOP_K = 5;

async function retrieveContext(message) {
  try {
    // Pinecone embeds `message` server-side via the index's own hosted model
    // (integrated inference) - no separate embedding call needed here.
    const textField = await pineconeService.getTextField();
    const hits = await pineconeService.searchByText(message, TOP_K);
    const chunks = hits.map((hit) => pineconeService.extractChunkText(hit, textField)).filter(Boolean);
    return chunks.join("\n\n---\n\n");
  } catch (error) {
    // A transient Pinecone failure shouldn't take down basic chat - degrade
    // to no context rather than failing the whole turn. Only visible
    // server-side; the client never sees this distinction.
    console.error("[agent] RAG retrieval failed, continuing with no context:", error.message);
    return "";
  }
}

function buildSystemPrompt(contextText, hasAttachment) {
  const context = contextText.trim() || "No relevant context found.";
  const base =
    "You are the Fusion AI Workflow Assistant, helping users build automation workflows on the Fusion platform.\n\n" +
    "You have a create_workflow_node tool available, but it is currently a stub that does not call the real " +
    "Fusion platform API. If you use it, tell the user that workflow creation isn't fully wired up yet.\n\n" +
    "Relevant context retrieved for this question:\n" +
    context;

  if (!hasAttachment) return base;

  return `${base}\n\n${WORKFLOW_SCHEMA_PROMPT}`;
}

// Turns a parsed attachment into either appended text on the user's message
// or a multimodal content array, and returns whether tool-calling should be
// skipped this turn (image turns need the model's full reasoning depth for
// what's a harder generation task, and openAiService only forces
// reasoning_effort:"none" when tools are attached).
async function foldAttachmentIntoMessage(message, attachment) {
  if (!attachment) return { content: message, hasAttachment: false };

  let parsed;
  try {
    parsed = await parseAttachment(attachment);
  } catch (error) {
    console.error("[agent] attachment parsing threw unexpectedly:", error.message);
    const note = `${message || "Analyze the attached file and build a workflow for it."}\n\n[Attached file: ${attachment.originalname} - could not be processed: ${error.message}]`;
    return { content: note, hasAttachment: true };
  }

  const baseText = message || "Analyze the attached file and build a workflow for it.";

  if (parsed.mode === "image") {
    return {
      content: [
        { type: "text", text: baseText },
        { type: "image_url", image_url: { url: parsed.dataUri } },
      ],
      hasAttachment: true,
      isImage: true,
    };
  }

  return {
    content: `${baseText}\n\n[Attached file: ${attachment.originalname}]\n${parsed.text}`,
    hasAttachment: true,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Relays an already-complete string through the SSE onToken callback,
// self-chunked to preserve the frontend's incremental-typing rendering. Every
// OpenAI call in the tool loop is non-streaming, so there's no real token
// stream to relay - this simulates one. (Real streaming is a valid future
// upgrade - OpenAI's Chat Completions streaming format is simple and
// well-documented - but isn't needed for the SSE contract to work correctly.)
async function relayTextAsTokens(text, onToken, signal) {
  const chunks = text.match(/\S+\s*/g) || [text];
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    onToken(chunk);
    await sleep(20);
  }
}

/**
 * Runs the full RAG + tool-calling agent loop for one user turn and streams
 * the final answer back via onToken. Same call signature the retired
 * streamFusionAiResponse had, so chatRoute.js's SSE framing is untouched.
 *
 * @param {Object} params
 * @param {string} params.message
 * @param {string} params.sessionId
 * @param {AbortSignal} params.signal
 * @param {(token: string) => void} params.onToken
 * @param {{buffer: Buffer, originalname: string, mimetype: string, size: number}} [params.attachment]
 */
async function streamAgentResponse({ message, sessionId, signal, onToken, attachment }) {
  const { content, hasAttachment, isImage } = await foldAttachmentIntoMessage(message, attachment);
  conversationStore.appendTurn(sessionId, { role: "user", content });

  // Retrieve fresh context for *this* question every turn (topics can shift
  // mid-conversation) and prepend it as a system message for this request
  // only - conversationStore never stores system messages, so history stays
  // just the user/assistant/tool exchange and doesn't accumulate stale context.
  const contextText = await retrieveContext(message);
  const systemMessage = { role: "system", content: buildSystemPrompt(contextText, hasAttachment) };
  const requestMessages = [systemMessage, ...conversationStore.getHistory(sessionId)];

  // Attachment turns skip tool-calling entirely: it structurally stops the
  // model from wasting a round-trip on the create_workflow_node stub instead
  // of returning workflow JSON.
  const tools = hasAttachment ? undefined : TOOL_DEFINITIONS;

  // reasoning_effort:"none" is normally only forced when tools are attached
  // (see openAiService.js), but attachment turns need it explicitly too:
  // left unconstrained, this model can spend its *entire* max_completion_tokens
  // budget on hidden reasoning tokens before emitting any visible output,
  // producing finish_reason "length" with empty content - confirmed
  // empirically on a real multi-node workflow generation. Workflow JSON
  // generation is a structured transformation task, not one that benefits
  // from extra chain-of-thought, so there's no tradeoff being made here.
  // maxTokens is raised well past the 4096 default for the same reason: a
  // real-world spec's full workflow JSON can itself run several thousand
  // tokens - 4096 was observed truncating mid-JSON even with reasoning
  // disabled. 8192 comfortably fit a 7-step example (~4k tokens used); a
  // much larger spec could still need more.
  const reasoningEffort = hasAttachment ? "none" : undefined;
  const maxTokens = hasAttachment ? 8192 : undefined;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await openAiService.createChatCompletion({
        messages: requestMessages,
        tools,
        reasoningEffort,
        ...(maxTokens ? { maxTokens } : {}),
        signal,
      });

      const choice = response.choices?.[0];
      const responseMessage = choice?.message;

      if (choice?.finish_reason === "tool_calls" && responseMessage?.tool_calls?.length) {
        conversationStore.appendTurn(sessionId, responseMessage);
        requestMessages.push(responseMessage);

        for (const toolCall of responseMessage.tool_calls) {
          let input = {};
          try {
            input = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            // Malformed arguments from the model - let the tool handler see an
            // empty object rather than crashing the loop.
          }
          const { content: toolContent } = executeTool(toolCall.function.name, input);
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: toolContent };
          conversationStore.appendTurn(sessionId, toolResultMessage);
          requestMessages.push(toolResultMessage);
        }
        continue;
      }

      // Final turn - no more pending tool calls.
      const finalText = responseMessage?.content || "I wasn't able to generate a response for that.";
      conversationStore.appendTurn(sessionId, { role: "assistant", content: finalText });
      await relayTextAsTokens(finalText, onToken, signal);
      return;
    }
  } catch (error) {
    if (error.name === "AbortError" || !isImage) throw error;

    // Deliberately broad v1 catch, scoped to image-bearing turns only: vision
    // support is unverified for the configured model (see openAiService.js),
    // so any failure here degrades to a friendly in-chat message instead of a
    // raw SSE error frame. Narrow this to the specific error once the real
    // failure shape is known.
    console.error("[agent] image attachment turn failed:", error.message);
    const fallbackText =
      "I wasn't able to analyze the attached image with the current model configuration. " +
      "Try attaching a spec document (PDF/JSON/XML/BPMN) instead, or describe the diagram in text.";
    conversationStore.appendTurn(sessionId, { role: "assistant", content: fallbackText });
    await relayTextAsTokens(fallbackText, onToken, signal);
    return;
  }

  throw new Error(`Agent exceeded ${MAX_TOOL_ITERATIONS} tool-call iterations without a final answer`);
}

module.exports = { streamAgentResponse };
