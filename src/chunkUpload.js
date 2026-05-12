/**
 * Chunked upload manager.
 * Splits large file uploads into resumable chunks (10 MB each).
 * Stores chunks in public/uploads/chunks/<uploadId>/ and merges on finalize.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const chunksBaseDir = path.join(uploadDir, 'chunks');
if (!fs.existsSync(chunksBaseDir)) fs.mkdirSync(chunksBaseDir, { recursive: true });

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB per chunk

// In-memory session tracking (uploadId -> metadata).
// Survives as long as the process runs; stale sessions cleaned up periodically.
const sessions = new Map();

/**
 * Initialize a chunked upload session.
 * @param {string} filename - Original filename
 * @param {number} fileSize - Total file size in bytes
 * @returns {{ uploadId, chunkSize, totalChunks }}
 */
function initSession(filename, fileSize) {
  const uploadId = crypto.randomBytes(16).toString('hex');
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunkDir = path.join(chunksBaseDir, uploadId);
  fs.mkdirSync(chunkDir, { recursive: true });

  const session = {
    uploadId,
    filename,
    fileSize,
    totalChunks,
    receivedChunks: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessions.set(uploadId, session);

  return { uploadId, chunkSize: CHUNK_SIZE, totalChunks };
}

/**
 * Get session info (for resume support).
 * @param {string} uploadId
 * @returns {object|null}
 */
function getSession(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) {
    // Try to reconstruct from disk (server restart scenario).
    const chunkDir = path.join(chunksBaseDir, uploadId);
    if (!fs.existsSync(chunkDir)) return null;
    // Can't fully reconstruct without metadata, return minimal info.
    return null;
  }
  return {
    uploadId: session.uploadId,
    filename: session.filename,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
    complete: session.receivedChunks.size === session.totalChunks,
  };
}

/**
 * Save a chunk to disk.
 * @param {string} uploadId
 * @param {number} chunkIndex - 0-based
 * @param {Buffer} data
 * @returns {{ received, total, complete }}
 */
function saveChunk(uploadId, chunkIndex, data) {
  const session = sessions.get(uploadId);
  if (!session) throw new Error('Upload session not found');
  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new Error(`Invalid chunk index ${chunkIndex} (total: ${session.totalChunks})`);
  }

  const chunkPath = path.join(chunksBaseDir, uploadId, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  fs.writeFileSync(chunkPath, data);
  session.receivedChunks.add(chunkIndex);
  session.lastActivity = Date.now();

  return {
    received: session.receivedChunks.size,
    total: session.totalChunks,
    complete: session.receivedChunks.size === session.totalChunks,
  };
}

/**
 * Merge all chunks into the final file.
 * @param {string} uploadId
 * @returns {{ filename, filePath, fileSize }}
 */
function finalize(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) throw new Error('Upload session not found');
  if (session.receivedChunks.size !== session.totalChunks) {
    throw new Error(`Missing chunks: got ${session.receivedChunks.size}/${session.totalChunks}`);
  }

  const safe = session.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalName = `${Date.now()}_${safe}`;
  const finalPath = path.join(uploadDir, finalName);

  // Merge chunks sequentially.
  const writeStream = fs.createWriteStream(finalPath);
  const chunkDir = path.join(chunksBaseDir, uploadId);

  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, '0')}`);
    const data = fs.readFileSync(chunkPath);
    writeStream.write(data);
  }
  writeStream.end();

  // Wait for write to finish (sync-ish via fd).
  // Since writeStream.end() flushes, the file should be complete after this.
  // We'll use a sync approach instead for reliability.
  writeStream.close();

  // Actually, let's do it fully sync for simplicity:
  fs.unlinkSync(finalPath); // remove the stream-created file
  const fd = fs.openSync(finalPath, 'w');
  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, '0')}`);
    const data = fs.readFileSync(chunkPath);
    fs.writeSync(fd, data);
  }
  fs.closeSync(fd);

  const stat = fs.statSync(finalPath);

  // Cleanup chunks.
  cleanup(uploadId);

  return { filename: finalName, filePath: finalPath, fileSize: stat.size };
}

/**
 * Remove chunk directory and session.
 */
function cleanup(uploadId) {
  const chunkDir = path.join(chunksBaseDir, uploadId);
  if (fs.existsSync(chunkDir)) {
    const files = fs.readdirSync(chunkDir);
    for (const f of files) {
      try { fs.unlinkSync(path.join(chunkDir, f)); } catch (_) {}
    }
    try { fs.rmdirSync(chunkDir); } catch (_) {}
  }
  sessions.delete(uploadId);
}

/**
 * Cleanup stale sessions (older than 24 hours with no activity).
 */
function cleanupStale() {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > maxAge) {
      cleanup(id);
    }
  }
  // Also clean orphan directories on disk.
  if (fs.existsSync(chunksBaseDir)) {
    const dirs = fs.readdirSync(chunksBaseDir);
    for (const dir of dirs) {
      if (!sessions.has(dir)) {
        const dirPath = path.join(chunksBaseDir, dir);
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && now - stat.mtimeMs > maxAge) {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            try { fs.unlinkSync(path.join(dirPath, f)); } catch (_) {}
          }
          try { fs.rmdirSync(dirPath); } catch (_) {}
        }
      }
    }
  }
}

// Run cleanup every hour.
setInterval(cleanupStale, 60 * 60 * 1000);

module.exports = {
  CHUNK_SIZE,
  initSession,
  getSession,
  saveChunk,
  finalize,
  cleanup,
  cleanupStale,
};
