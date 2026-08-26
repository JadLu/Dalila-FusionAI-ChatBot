// Tier 0 diagnostic: confirms the Pinecone index is really an
// integrated-inference index, reveals its real fieldMap/model, and confirms
// a text-in/matches-out searchRecords() call actually works - before
// pineconeService.js's assumptions get relied on by the agent orchestrator.
// Usage: node scripts/verify-pinecone-index.js
require("dotenv").config();

const { Pinecone } = require("@pinecone-database/pinecone");

async function main() {
  const { PINECONE_API_KEY, PINECONE_INDEX_NAME } = process.env;

  if (!PINECONE_API_KEY || !PINECONE_INDEX_NAME) {
    console.error("PINECONE_API_KEY and PINECONE_INDEX_NAME must be set in .env");
    process.exit(1);
  }

  const client = new Pinecone({ apiKey: PINECONE_API_KEY });

  console.log(`--- describeIndex("${PINECONE_INDEX_NAME}") ---`);
  const description = await client.describeIndex(PINECONE_INDEX_NAME);
  console.log(JSON.stringify(description, null, 2));

  const embed = description?.embed;
  if (!embed) {
    console.log(
      "\nNo `embed` block on this index - it may NOT be an integrated-inference index after all. " +
        "If so, pineconeService.js's searchByText()/searchRecords() approach won't work and this needs " +
        "re-designed around raw vectors + a separate embedding provider instead."
    );
  } else {
    console.log(`\nConfirmed integrated-inference index. model="${embed.model}", fieldMap=${JSON.stringify(embed.fieldMap)}`);
    const textField = embed.fieldMap?.text;
    console.log(`Text field to use in pineconeService.js: "${textField}"`);
  }

  const index = client.index(PINECONE_INDEX_NAME);

  console.log("\n--- describeIndexStats() ---");
  const stats = await index.describeIndexStats();
  console.log(JSON.stringify(stats, null, 2));
  const namespaces = Object.keys(stats?.namespaces || {});
  console.log(`\nNamespaces found: ${namespaces.length ? namespaces.join(", ") : "(default namespace only)"}`);

  console.log('\n--- sample searchRecords({query:{topK:1, inputs:{text:"test"}}}) ---');
  const result = await index.searchRecords({ query: { topK: 1, inputs: { text: "test" } } });
  console.log(JSON.stringify(result, null, 2));

  const hit = result?.result?.hits?.[0];
  if (!hit) {
    console.log("No hits returned - index may be empty, or the response shape differs from what pineconeService.js expects.");
    return;
  }
  console.log("\nSample hit fields:", Object.keys(hit.fields || {}));
  console.log(
    "\nCompare these against FALLBACK_TEXT_FIELDS / the resolved fieldMap text field in " +
      "src/services/pineconeService.js - add the real field name if it's not already covered."
  );
}

main().catch((err) => {
  console.error("SCRIPT ERROR:", err);
  process.exit(1);
});
