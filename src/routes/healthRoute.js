const express = require("express");

const router = express.Router();

// GET /health - simple liveness probe for uptime monitors / load balancers.
router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

module.exports = router;
