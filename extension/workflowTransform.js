// Converts the chatbot's workflow JSON (human-readable: array-shaped
// inputs/outputs, UUID node ids - matches src/agent/workflowSchemaPrompt.js
// in the bridge) into the shape the real Fusion platform's
// PATCH /api/graphs/:id endpoint actually expects. Confirmed empirically
// against the live platform (not documented anywhere):
//   - node ids are ~24-char lowercase alphanumeric strings, not UUIDs
//   - node.data.inputs/outputs are objects keyed by port name ({label}),
//     not arrays of {name, type, description}
//   - nodes carry width/height (64/64 observed), showRunningStatus, _morphing
//   - connections carry an "xy-edge__<source><sourceHandle>-<target><targetHandle>"
//     id and a data.isAnimated flag, on top of source/sourceHandle/target/targetHandle/type
// Loaded into the background service worker via importScripts (see background.js).

function generateCanvasNodeId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function portsToObject(ports) {
  const obj = {};
  for (const port of ports || []) {
    if (port && port.name) obj[port.name] = { label: port.label || port.name };
  }
  return obj;
}

/**
 * @param {Object} workflow - the chatbot-generated workflow ({name, nodes, connections, ...})
 * @returns {{nodes: Array, connections: Array}} real-API-shaped nodes/connections
 */
function transformWorkflowForCanvas(workflow) {
  const idMap = {}; // LLM-generated id -> real-format id, so edges can be remapped too

  const nodes = (workflow.nodes || []).map((node) => {
    const newId = generateCanvasNodeId();
    idMap[node.id] = newId;
    const data = node.data || {};
    return {
      id: newId,
      position: node.position || { x: 0, y: 0 },
      type: node.type,
      width: 64,
      height: 64,
      data: {
        name: data.name,
        label: data.label || data.name,
        inputs: portsToObject(data.inputs),
        outputs: portsToObject(data.outputs),
        description: data.description || "",
        showRunningStatus: false,
        parameters: data.parameters || {},
        _morphing: false,
      },
    };
  });

  const connections = (workflow.connections || [])
    .map((conn) => {
      const source = idMap[conn.source];
      const target = idMap[conn.target];
      // Skip rather than send a reference to a node id that didn't map -
      // a broken edge would corrupt the canvas silently otherwise.
      if (!source || !target) return null;
      return {
        source,
        sourceHandle: conn.sourceHandle,
        target,
        targetHandle: conn.targetHandle,
        type: conn.type || "directed",
        id: `xy-edge__${source}${conn.sourceHandle}-${target}${conn.targetHandle}`,
        data: { isAnimated: false },
      };
    })
    .filter(Boolean);

  return { nodes, connections };
}
