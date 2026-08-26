// Condensed from FUSION_AI_Workflow_Guide.md (repo root, one level above this
// app) so the model doesn't need the full guide in context on every
// attachment turn. Keep this in sync by hand if the guide changes shape.
const WORKFLOW_SCHEMA_PROMPT = `
The user has attached a specification or BPMN diagram. Your job this turn is
to analyze its content (already extracted and appended to their message
below) and respond with a complete FUSION AI workflow JSON, followed by a
short plain-language summary of what you built.

Do NOT use create_workflow_node for this - it is still a stub. Instead,
output the full workflow as a fenced \`\`\`json code block matching this shape:

Root object: { name, nodes: [...], connections: [...], variables: {},
secrets: {}, status: "draft", version: 1 }

Each node: { id (uuid), position: {x, y}, type, data: { name, label, inputs,
outputs, description, parameters } }
- type is one of: "trigger", "action", "utility", "agent", "agent-llm"
- data.name is the specific integration, e.g. "webhook", "function",
  "http-request", "if-else", "agent-llm", "agent"
- Trigger node types: cron, webhook, manual-trigger
- Action node types: function, google-sheets-values, gmail, slack-action,
  postgres-action, http-request, parse-xml, google-docs
- AI node types: agent-llm (the model config), agent (the persona/systemPrompt)
- Utility node types: loop, if-else, merge, delay

Each connection: { source, sourceHandle, target, targetHandle, type }
- sourceHandle is usually "success", "loop", "true", or "false"
- targetHandle is usually "input" or "next"
- type is "directed" for normal flow, or "agentConnection" to link an
  agent-llm node to its agent node

Map every step, decision point, and branch from the attached spec/BPMN to a
node and connection. Start from a trigger node. Use if-else utility nodes for
BPMN gateways/decision branches. Keep the JSON valid and complete - don't
truncate it or leave placeholders.
`.trim();

module.exports = { WORKFLOW_SCHEMA_PROMPT };
