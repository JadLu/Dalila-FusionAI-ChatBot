// Stub tool: the real Fusion platform workflow-CRUD API isn't documented yet.
// This lets the tool-calling loop be fully built and tested now, ready to
// swap in a real implementation later without changing the orchestrator.
const definition = {
  type: "function",
  function: {
    name: "create_workflow_node",
    description:
      "Creates a new node in the user's Fusion automation workflow. NOTE: this is a stub - it does not yet " +
      "call the real Fusion platform API and will not actually create anything. If you use this tool, tell " +
      "the user that workflow creation isn't fully wired up yet.",
    parameters: {
      type: "object",
      properties: {
        node_type: { type: "string", description: "The kind of workflow node to create, e.g. 'trigger', 'action', 'condition'." },
        name: { type: "string", description: "Human-readable name for the node." },
        config: { type: "object", description: "Arbitrary node-specific configuration, shape TBD once the real Fusion platform API is documented." },
      },
      required: ["node_type", "name"],
    },
  },
};

function handler(input) {
  console.log("[tool:create_workflow_node]", JSON.stringify(input));
  return {
    status: "not_implemented",
    message: "Workflow creation isn't wired up to the real Fusion platform API yet - this is a stub.",
    received_input: input,
  };
}

module.exports = { definition, handler };
