const createWorkflowNode = require("./createWorkflowNode");

const TOOLS_BY_NAME = {
  [createWorkflowNode.definition.function.name]: createWorkflowNode,
};

const TOOL_DEFINITIONS = Object.values(TOOLS_BY_NAME).map((tool) => tool.definition);

/**
 * Executes a tool by name. Never throws - a broken handler shouldn't kill the
 * whole agent loop, so failures become an is_error tool_result instead.
 * @returns {{ content: string, isError: boolean }}
 */
function executeTool(name, input) {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) {
    return { content: `Unknown tool "${name}"`, isError: true };
  }

  try {
    const result = tool.handler(input);
    return { content: JSON.stringify(result), isError: false };
  } catch (error) {
    console.error(`[tools] "${name}" handler threw:`, error.message);
    return { content: `Tool "${name}" failed: ${error.message}`, isError: true };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
