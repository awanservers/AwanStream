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
const META_FILE = 'meta.json';

// In-memory session tracking (uploadId -> metadata).
// Reconstructed from disk on boot via reconcileOnBoot() so resume survives
// server restarts. Stale sessions cleaned up periodically.
const sessions = new Map();

function metaPath(uploadId) {
  return path.join(chunksBaseDir, uploadId, META_FILE);
}

function writeMeta(session) {
  const meta = {
    uploadId: session.uploadId,
    filename: session.filename,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
  };
  try {
    fs.writeFileSync(metaPath(session.uploadId), JSON.stringify(meta));
  } catch (e) {
    console.error('[chunkUpload] writeMeta failed:', e.message);
  }
}

// Scan a chunk directory and return Set of received chunk indices.
function scanReceivedChunks(uploadId) {
  const dir = path.join(chunksBaseDir, uploadId);
  const received = new Set();
  if (!fs.existsSync(dir)) return received;
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return received; }
  for (const f of files) {
    const m = /^chunk_(\d{6})$/.exec(f);
    if (m) received.add(Number(m[1]));
  }
  return received;
}

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
  writeMeta(session);

  return { uploadId, chunkSize: CHUNK_SIZE, totalChunks };
}

/**
 * Get session info (for resume support). Falls back to disk reconstruction
 * if the in-memory entry was lost (e.g., after server restart before
 * reconcileOnBoot has run, or session was never registered in this process).
 *
 * @param {string} uploadId
 * @returns {object|null}
 */
function getSession(uploadId) {
  let session = sessions.get(uploadId);
  if (!session) {
    // Try to reconstruct from disk (server restart, or just-rebuilt session).
    const dir = path.join(chunksBaseDir, uploadId);
    if (!fs.existsSync(dir)) return null;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(uploadId), 'utf8'));
    } catch (_) {
      return null; // metadata gone, can't safely resume
    }
    session = {
      ...meta,
      receivedChunks: scanReceivedChunks(uploadId),
      lastActivity: Date.now(),
    };
    sessions.set(uploadId, session);
  }
  return {
    uploadId: session.uploadId,
    filename: session.filename,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    chunkSize: CHUNK_SIZE,
    receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
    complete: session.receivedChunks.size === session.totalChunks,
  };
}

/**
 * Save a chunk to disk. Idempotent — re-uploading the same index is fine
 * (overwrites existing chunk file with identical content).
 * @param {string} uploadId
 * @param {number} chunkIndex - 0-based
 * @param {Buffer} data
 * @returns {{ received, total, complete }}
 */
function saveChunk(uploadId, chunkIndex, data) {
  let session = sessions.get(uploadId);
  if (!session) {
    // Try to reconstruct on-demand (e.g., chunk arrives just after restart
    // before any /status call).
    const info = getSession(uploadId);
    if (!info) throw new Error('Upload session not found');
    session = sessions.get(uploadId);
  }
  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new Error(`Invalid chunk index ${chunkIndex} (total: ${session.totalChunks})`);
  }

  const chunkPath = path.join(chunksBaseDir, uploadId, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  fs.writeFileSync(chunkPath, data);
  session.receivedChunks.add(chunkIndex);
  session.lastActivity = Date.now();
  // Persist activity timestamp so resume after restart still has fresh mtime.
  writeMeta(session);

  return {
    received: session.receivedChunks.size,
    total: session.totalChunks,
    complete: session.receivedChunks.size === session.totalChunks,
  };
}

/**
 * Merge all chunks into the final file (streaming, memory-safe).
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
  const chunkDir = path.join(chunksBaseDir, uploadId);

  // Stream chunks sequentially via fd to avoid loading any full chunk into a
  // long-lived buffer beyond a single read at a time. fs.copyFileSync would
  // overwrite, so we open once for write and append each chunk.
  const fdOut = fs.openSync(finalPath, 'w');
  try {
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, '0')}`);
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Chunk file missing on disk: ${i}`);
      }
      const data = fs.readFileSync(chunkPath);
      fs.writeSync(fdOut, data);
    }
  } finally {
    fs.closeSync(fdOut);
  }

  const stat = fs.statSync(finalPath);

  // Sanity check: merged size should match declared file size (off-by-one
  // tolerable for last chunk). If wildly off, the upload is corrupt.
  if (Math.abs(stat.size - session.fileSize) > 1024) {
    try { fs.unlinkSync(finalPath); } catch (_) {}
    throw new Error(`Size mismatch: merged=${stat.size}, expected=${session.fileSize}`);
  }

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
  // Also clean orphan directories on disk (sessions Map lost on restart).
  if (fs.existsSync(chunksBaseDir)) {
    let dirs = [];
    try { dirs = fs.readdirSync(chunksBaseDir); } catch (_) { return; }
    for (const dir of dirs) {
      if (sessions.has(dir)) continue;
      const dirPath = path.join(chunksBaseDir, dir);
      try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs <= maxAge) continue;
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          try { fs.unlinkSync(path.join(dirPath, f)); } catch (_) {}
        }
        try { fs.rmdirSync(dirPath); } catch (_) {}
      } catch (_) { /* dir gone between readdir and stat */ }
    }
  }
}

/**
 * Rebuild in-memory sessions Map from disk metadata. Called once at boot so
 * resume works across server restarts. Sessions without a meta.json are
 * treated as orphans and left alone (will be GC'd by cleanupStale).
 */
function reconcileOnBoot() {
  if (!fs.existsSync(chunksBaseDir)) return;
  let dirs;
  try { dirs = fs.readdirSync(chunksBaseDir); } catch (_) { return; }
  let restored = 0;
  for (const dir of dirs) {
    const metaP = path.join(chunksBaseDir, dir, META_FILE);
    if (!fs.existsSync(metaP)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (!meta.uploadId || !meta.filename || !meta.fileSize || !meta.totalChunks) continue;
      sessions.set(meta.uploadId, {
        ...meta,
        receivedChunks: scanReceivedChunks(meta.uploadId),
      });
      restored++;
    } catch (_) { /* corrupt meta — skip */ }
  }
  if (restored > 0) {
    console.log(`[chunkUpload] restored ${restored} resumable upload session${restored > 1 ? 's' : ''}`);
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
  reconcileOnBoot,
};
