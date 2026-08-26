require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const { buildCorsOptions } = require("./src/middleware/corsConfig");
const { notFoundHandler, errorHandler } = require("./src/middleware/errorHandler");
const chatRoute = require("./src/routes/chatRoute");
const healthRoute = require("./src/routes/healthRoute");

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security / cross-origin setup ---
app.use(cors(buildCorsOptions()));
app.use(express.json());

// Serve the embeddable widget assets and the demo page:
// <script src="http://localhost:3001/widget.js" defer></script>
app.use(express.static(path.join(__dirname, "public")));

// --- Routes ---
app.use("/api", chatRoute); // POST /api/chat
app.use("/", healthRoute); // GET /health

// --- Fallbacks ---
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Fusion AI API bridge listening on http://localhost:${PORT}`);
});
