const path = require("path");
const multer = require("multer");

// Extensions accepted for POST /api/chat/upload. Checked case-insensitively
// against the original filename - NOT against mimetype, because .bpmn files
// have no standard MIME type (browsers/OS commonly send
// "application/octet-stream" or nothing at all for them), so a strict
// mimetype allowlist would reject legitimate BPMN uploads.
const ALLOWED_EXTENSIONS = new Set([".pdf", ".json", ".xml", ".bpmn", ".png", ".jpg", ".jpeg"]);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024;

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const error = new Error(
      `Unsupported file type "${ext || "(none)"}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
    );
    error.code = "UNSUPPORTED_FILE_TYPE";
    return cb(error);
  }
  cb(null, true);
}

// Memory storage only - files live in the request's Buffer for the duration
// of one turn and are never written to disk, matching the "in-memory only,
// discarded after use" decision (there's no persistence layer in this
// project at all).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter,
});

module.exports = { upload, ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES };
