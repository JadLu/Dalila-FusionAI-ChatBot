/**
 * Builds a `cors` options object from the ALLOWED_ORIGINS env var.
 * ALLOWED_ORIGINS is a comma-separated list, e.g.
 *   "http://localhost:3000,http://127.0.0.1:5500"
 */
function buildCorsOptions() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  const allowedOrigins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin(origin, callback) {
      // Allow non-browser requests (curl, server-to-server, health checks)
      // that don't send an Origin header at all.
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Browser extensions send a real chrome-extension://<id> Origin header.
      // IDs aren't stable across installs/checkouts (they're derived from the
      // unpacked folder path, or reassigned on publish), so an ID-specific
      // allowlist entry would only ever cover one developer's one checkout.
      // /api/chat has no auth today regardless, so this doesn't change the
      // actual risk profile - it's still just bounding which *websites* can
      // call the bridge from a visitor's browser.
      if (origin.startsWith("chrome-extension://")) {
        return callback(null, true);
      }

      const error = new Error(`Origin "${origin}" is not allowed by CORS policy`);
      error.status = 403;
      return callback(error);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  };
}

module.exports = { buildCorsOptions };
