// Wraps the user's Pinecone index for RAG retrieval. This index uses
// Pinecone's *integrated inference* (it was created bound to a hosted
// embedding model - llama-text-embed-v2, confirmed via the console) - Pinecone
// embeds text server-side on both upsert and query, so we send raw text via
// searchRecords() and never touch an embedding vector ourselves.
const { Pinecone } = require("@pinecone-database/pinecone");

let cachedIndex = null;
let cachedTextField = null; // resolved lazily from the index's real fieldMap

function getIndex() {
  if (cachedIndex) return cachedIndex;

  const { PINECONE_API_KEY, PINECONE_INDEX_NAME } = process.env;
  if (!PINECONE_API_KEY || !PINECONE_INDEX_NAME) {
    throw new Error("PINECONE_API_KEY / PINECONE_INDEX_NAME are not configured on the server");
  }

  const client = new Pinecone({ apiKey: PINECONE_API_KEY });
  cachedIndex = client.index(PINECONE_INDEX_NAME);
  return cachedIndex;
}

// Resolves the index's configured text field (Pinecone's "fieldMap", e.g.
// {text: "chunk_text"}) so extractChunkText knows exactly where to look
// instead of guessing. Cached after the first successful lookup.
async function getTextField() {
  if (cachedTextField) return cachedTextField;

  const { PINECONE_API_KEY, PINECONE_INDEX_NAME } = process.env;
  const client = new Pinecone({ apiKey: PINECONE_API_KEY });
  const description = await client.describeIndex(PINECONE_INDEX_NAME);
  const fieldMapText = description?.embed?.fieldMap?.text;

  if (typeof fieldMapText === "string" && fieldMapText) {
    cachedTextField = fieldMapText;
  }
  return cachedTextField;
}

// The exact text field name is resolved from the index's real fieldMap via
// getTextField() where possible; these are a defensive fallback for the rare
// case that lookup fails (e.g. a transient describeIndex error) - same
// convention the retired fusionAiService used for an unknown upstream shape.
const FALLBACK_TEXT_FIELDS = ["chunk_text", "text", "content"];
let warnedAboutMissingTextField = false;

function extractChunkText(hit, resolvedTextField) {
  const fields = hit?.fields;
  if (!fields) return null;

  if (resolvedTextField && typeof fields[resolvedTextField] === "string" && fields[resolvedTextField].trim()) {
    return fields[resolvedTextField];
  }

  for (const field of FALLBACK_TEXT_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && value.trim()) return value;
  }

  if (!warnedAboutMissingTextField) {
    warnedAboutMissingTextField = true;
    console.warn(
      `[pineconeService] a hit had fields but none matched the resolved text field ("${resolvedTextField}") ` +
        `or the fallback names (${FALLBACK_TEXT_FIELDS.join(", ")}). Fields seen: ${Object.keys(fields).join(", ")}`
    );
  }
  return null;
}

/**
 * Searches the configured Pinecone index with raw text - Pinecone embeds it
 * server-side using the index's own hosted model, so there's no separate
 * embedding step here.
 * @param {string} text
 * @param {number} [topK]
 * @param {string} [namespace]
 * @returns {Promise<Array>} raw hit objects (each with a "fields" object)
 */
async function searchByText(text, topK = 5, namespace) {
  const index = namespace ? getIndex().namespace(namespace) : getIndex();
  const result = await index.searchRecords({ query: { topK, inputs: { text } } });
  return result?.result?.hits || [];
}

module.exports = { searchByText, extractChunkText, getTextField, getIndex };
