function notFoundHandler(req, res) {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
}

// Express recognizes this as an error-handling middleware because it takes
// 4 arguments - keep the (err, req, res, next) signature even if `next` is unused.
function errorHandler(err, req, res, next) {
  console.error("[error]", err.message);

  // If we've already started streaming a response (e.g. mid-SSE), the
  // headers are sent and we can only delegate to Express's default handler.
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
}

module.exports = { notFoundHandler, errorHandler };
