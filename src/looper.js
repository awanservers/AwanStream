// Video looper: take a short clip and produce a long looped version.
//
// Two modes:
//   fast   — single FFmpeg pass, -stream_loop -1 -c copy. No re-encode, very
//            fast, but loop boundary is visible (frame L → frame 0 jump).
//            Best when the clip already starts and ends on similar frames.
//   smooth — two-phase pipeline:
//              phase 1: create a "seamless unit" (length = L-D) where the
//                       boundary at start/end is a D-second crossfade between
//                       the tail and the head of the source. Re-encoded to
//                       h264+aac so it's stream-ready.
//              phase 2: -stream_loop -1 -c copy the seamless unit to the final
//                       target duration. Fast because no re-encode.
//            Net result: when the clip loops, the join is inside a crossfade,
//            so the eye never catches a hard frame jump.
//
// Output is inserted as a new video row (never overwrites the source).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const transcoder = require('./transcoder');
const audioManager = require('./audioManager');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// jobId (string) ->
// {
//   mode: 'fast' | 'smooth',
//   phase: 1 | 2,
//   phaseLabel: string,
//   process: current ffmpeg child,
//   progress: { percent, time, duration, speed, phase, phaseLabel },
//   sourceVideoId, outputVideoId, target, startedAt,
//   cancelRequested: bool,
// }
const jobs = new Map();
let nextJobId = Date.now();

// Parse "HH:MM:SS.xx" → seconds (float).
function parseTime(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function isRunning(jobId) {
  return jobs.has(String(jobId));
}

function getJob(jobId) {
  return jobs.get(String(jobId)) || null;
}

function listJobs() {
  const out = [];
  for (const [id, j] of jobs.entries()) {
    out.push({
      jobId: id,
      mode: j.mode,
      sourceVideoId: j.sourceVideoId,
      outputVideoId: j.outputVideoId,
      target: j.target,
      progress: j.progress,
      startedAt: j.startedAt,
    });
  }
  return out;
}

function getProgress(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) return null;
  return {
    jobId: String(jobId),
    mode: j.mode,
    sourceVideoId: j.sourceVideoId,
    outputVideoId: j.outputVideoId,
    target: j.target,
    percent: j.progress.percent,
    time: j.progress.time,
    duration: j.progress.duration,
    speed: j.progress.speed,
    phase: j.progress.phase,
    phaseLabel: j.progress.phaseLabel,
    startedAt: j.startedAt,
  };
}

/**
 * Start a loop job.
 *
 * @param {number}  sourceVideoId
 * @param {number}  targetSeconds
 * @param {string}  [title]
 * @param {object}  [options]
 * @param {boolean} [options.smooth=true]        Enable crossfade seamless loop.
 * @param {number}  [options.crossfadeSeconds=1] Crossfade duration (smooth only).
 * @param {boolean} [options.loopSafe=false]     Round smooth output to a full seamless-unit boundary.
 * @param {number}  [options.audioId]            Optional audio track id to overlay.
 * @param {number}  [options.audioVolume=0.3]    Volume of overlay audio (mix mode).
 * @param {string}  [options.audioMode='mix']    'mix' (preserve video audio) or 'replace'.
 * @returns {{ jobId: string, outputVideoId: number, outputFilename: string, mode: string }}
 */
function start(sourceVideoId, targetSeconds, title, options = {}) {
  const src = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(sourceVideoId));
  if (!src) throw new Error('Source video not found');

  const srcPath = path.join(uploadDir, src.filename);
  if (!fs.existsSync(srcPath)) throw new Error('Source file missing on disk');

  const requestedTarget = Number(targetSeconds);
  if (!Number.isFinite(requestedTarget) || requestedTarget <= 0) {
    throw new Error('Target duration must be a positive number of seconds');
  }
  if (requestedTarget > 24 * 3600) {
    throw new Error('Target duration cannot exceed 24 hours');
  }

  // Ensure we know source duration.
  let srcDuration = src.duration_seconds;
  if (!srcDuration) {
    srcDuration = transcoder.probeDuration(srcPath);
    if (srcDuration) {
      db.prepare('UPDATE videos SET duration_seconds=? WHERE id=?').run(srcDuration, src.id);
    }
  }
  if (!srcDuration) {
    throw new Error('Cannot detect source duration. Probe failed.');
  }
  if (requestedTarget < srcDuration) {
    throw new Error(`Target (${requestedTarget}s) is shorter than source (${Math.round(srcDuration)}s). Pick a longer target.`);
  }

  const smooth = options.smooth !== false;
  const loopSafe = smooth && options.loopSafe === true;
  let crossfadeSec = Number(options.crossfadeSeconds);
  if (!Number.isFinite(crossfadeSec) || crossfadeSec <= 0) crossfadeSec = 1.0;

  // Resolve optional audio overlay.
  let audioPath = null;
  let audioVolume = '0.3';
  let audioMode = 'mix'; // 'mix' = preserve video audio + overlay; 'replace' = overlay only
  if (options.audioId) {
    audioPath = audioManager.getFilePath(options.audioId);
    if (!audioPath) {
      throw new Error('Audio track not found or file missing on disk');
    }
    const vol = parseFloat(options.audioVolume);
    if (Number.isFinite(vol) && vol >= 0 && vol <= 2) audioVolume = String(vol);
    if (options.audioMode === 'replace') audioMode = 'replace';
  }

  // Smooth needs L > 2*D (some tail, some head, some middle). If not, shrink D
  // to fit, or reject if still too short.
  if (smooth) {
    const minLen = 2 * crossfadeSec + 0.5;
    if (srcDuration < minLen) {
      // Try shrinking crossfade. Aim for D = floor(srcDuration/3 * 10)/10 so at
      // least ~1/3 of clip is middle. Require ≥0.3s crossfade to be visible.
      const shrunk = Math.floor((srcDuration / 3) * 10) / 10;
      if (shrunk < 0.3) {
        throw new Error(`Source (${srcDuration.toFixed(1)}s) too short for smooth mode. Use fast mode or pick a longer clip (≥2s).`);
      }
      crossfadeSec = shrunk;
    }
  }

  let target = requestedTarget;
  let seamlessLen = null;
  if (loopSafe) {
    seamlessLen = srcDuration - crossfadeSec;
    target = roundUpToLoopSafeTarget(requestedTarget, seamlessLen);
  }

  // Insert output row up-front.
  const base = src.filename.replace(/\.[^.]+$/, '');
  const outFilename = `${Date.now()}_${base}_loop.mp4`;
  const outPath = path.join(uploadDir, outFilename);
  const modeLabel = smooth ? 'smooth' : 'loop';
  const baseTitle = (title && String(title).trim()) ||
    `${src.title} (${modeLabel} ${formatTargetLabel(target)})`;
  const finalTitle = uniqueVideoTitle(baseTitle);

  const jobId = String(nextJobId++);

  const insert = db.prepare(`INSERT INTO videos
    (title, filename, size_bytes, duration_seconds, status, folder_id,
     src_width, src_height, src_fps, loop_job_id)
    VALUES (?, ?, 0, ?, 'transcoding', ?, ?, ?, ?, ?)`);
  const result = insert.run(
    finalTitle,
    outFilename,
    target,
    src.folder_id || null,
    src.src_width || null,
    src.src_height || null,
    src.src_fps || null,
    jobId
  );
  const outputVideoId = Number(result.lastInsertRowid);
  const logPath = path.join(logsDir, `loop-${jobId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} starting loop job=${jobId} mode=${smooth ? 'smooth' : 'fast'} src=${src.id} L=${srcDuration.toFixed(2)}s requestedTarget=${requestedTarget}s target=${target}s crossfade=${crossfadeSec}s loopSafe=${loopSafe ? `yes seamlessLen=${seamlessLen.toFixed(3)}s` : 'no'} audio=${audioPath ? `${options.audioId} (${audioMode}, vol=${audioVolume})` : 'none'}\n`);

  const jobState = {
    mode: smooth ? 'smooth' : 'fast',
    phase: 1,
    progress: {
      percent: 0,
      time: 0,
      duration: target,
      speed: null,
      phase: 1,
      phaseLabel: smooth ? 'Creating seamless unit' : 'Looping',
    },
    sourceVideoId: src.id,
    outputVideoId,
    target,
    startedAt: Date.now(),
    cancelRequested: false,
    process: null,
  };
  jobs.set(jobId, jobState);

  const ctx = {
    jobId,
    srcPath,
    srcDuration,
    target,
    crossfadeSec,
    outPath,
    outputVideoId,
    logStream,
    jobState,
    audioPath,
    audioVolume,
    audioMode,
  };

  if (smooth) {
    runSmoothPhase1(ctx);
  } else {
    runFastPhase(ctx);
  }

  return {
    jobId,
    outputVideoId,
    outputFilename: outFilename,
    mode: jobState.mode,
    requestedTarget,
    target,
    loopSafe,
  };
}

// ---------------------------------------------------------------------------
// Fast mode: one FFmpeg pass, -c copy.
// ---------------------------------------------------------------------------

function runFastPhase(ctx) {
  const { srcPath, target, outPath, outputVideoId, logStream, jobState, jobId,
          audioPath, audioVolume, audioMode } = ctx;

  // When an audio overlay is attached, we must re-encode audio (amix filter),
  // but video can still be copied. Otherwise plain `-c copy` is fastest.
  const args = [
    '-hide_banner', '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-stream_loop', '-1',
    '-i', srcPath,
  ];

  if (audioPath) {
    args.push('-stream_loop', '-1', '-i', audioPath);
  }

  if (audioPath) {
    // Check if source video has audio (cached or probe once).
    const srcHasAudio = probeHasAudio(srcPath);

    // Build the audio filter chain. Final stages: loudnorm to -14 LUFS
    // (YouTube standard) followed by alimiter as a brick-wall safety against
    // peaks that loudnorm's internal limiter might miss (crackling fire has
    // sharp transients that sometimes slip through).
    const masterFilter = 'loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=-1.5dB:level=disabled';

    if (audioMode === 'replace' || !srcHasAudio) {
      // Overlay becomes the only audio.
      args.push(
        '-filter_complex',
        `[1:a]volume=${audioVolume},${masterFilter}[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    } else {
      // Mix video audio (full volume) + overlay (configurable volume).
      args.push(
        '-filter_complex',
        `[0:a]volume=1.0[va];[1:a]volume=${audioVolume}[oa];[va][oa]amix=inputs=2:duration=first:dropout_transition=2,${masterFilter}[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    }
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    );
  } else {
    args.push(
      '-c', 'copy',
      '-map', '0:v:0', '-map', '0:a:0?',
    );
  }

  args.push(
    '-t', String(target),
    '-movflags', '+faststart',
    outPath,
  );

  logStream.write(`=== phase 1 (fast loop) cmd: ffmpeg ${args.join(' ')}\n`);
  const proc = spawnWithProgress(args, logStream, jobState, {
    denominator: target,
    phase: 1,
    phaseLabel: 'Looping',
    weight: { start: 0, end: 100 },
  });
  jobState.process = proc;

  proc.on('exit', (code, signal) => {
    logStream.write(`\n=== phase 1 exit code=${code} signal=${signal}\n`);
    finishJob(ctx, code, signal);
  });
  proc.on('error', (err) => handleSpawnError(ctx, err));
}

// ---------------------------------------------------------------------------
// Smooth mode: phase 1 create seamless unit, phase 2 loop it with -c copy.
// ---------------------------------------------------------------------------

function runSmoothPhase1(ctx) {
  const { srcPath, srcDuration, crossfadeSec, logStream, jobState, jobId } = ctx;

  // Temp file for the seamless unit, placed in uploads dir so phase 2 can read
  // it. We delete it after phase 2 finishes.
  const seamlessFilename = `.loop_seamless_${jobId}.mp4`;
  const seamlessPath = path.join(uploadDir, seamlessFilename);
  ctx.seamlessPath = seamlessPath;

  const L = srcDuration;
  const D = crossfadeSec;
  // Seamless unit length — see module docstring for derivation.
  const seamlessLen = L - D;
  ctx.seamlessLen = seamlessLen;

  // Build filter_complex to produce a clip of length L-D where:
  //   [0, D]     = crossfade(tail=A[L-D:L] → head=A[0:D])
  //   [D, L-D]   = middle = A[D:L-D]
  // When this plays on loop, the "joint" between iterations falls inside the
  // crossfade at the start, so there's no hard jump.
  //
  // We probe for audio first so we can conditionally include acrossfade.
  const info = transcoder.probeVideoInfo(srcPath);
  const hasAudio = !!info.audioCodec;

  const vfilter = [
    `[0:v]trim=0:${D},setpts=PTS-STARTPTS[vhead]`,
    `[0:v]trim=${L - D}:${L},setpts=PTS-STARTPTS[vtail]`,
    `[0:v]trim=${D}:${L - D},setpts=PTS-STARTPTS[vmid]`,
    `[vtail][vhead]xfade=transition=fade:duration=${D}:offset=0[vblend]`,
    `[vblend][vmid]concat=n=2:v=1:a=0[vout]`,
  ].join(';');

  let filter = vfilter;
  const mapArgs = ['-map', '[vout]'];
  if (hasAudio) {
    const afilter = [
      `[0:a]atrim=0:${D},asetpts=PTS-STARTPTS[ahead]`,
      `[0:a]atrim=${L - D}:${L},asetpts=PTS-STARTPTS[atail]`,
      `[0:a]atrim=${D}:${L - D},asetpts=PTS-STARTPTS[amid]`,
      `[atail][ahead]acrossfade=d=${D}[ablend]`,
      `[ablend][amid]concat=n=2:v=0:a=1[aout]`,
    ].join(';');
    filter = vfilter + ';' + afilter;
    mapArgs.push('-map', '[aout]');
  }

  const args = [
    '-hide_banner', '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-i', ctx.srcPath,
    '-filter_complex', filter,
    ...mapArgs,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
  ];
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
  }
  args.push('-movflags', '+faststart', seamlessPath);

  logStream.write(`=== phase 1 (seamless unit, L=${L} D=${D} seamlessLen=${seamlessLen} hasAudio=${hasAudio}) cmd: ffmpeg ${args.join(' ')}\n`);

  // Phase 1 progress goes 0-60% of the bar (this is the slow part — actual
  // encoding). Phase 2 covers 60-100%.
  jobState.phase = 1;
  jobState.progress.phase = 1;
  jobState.progress.phaseLabel = 'Creating seamless unit';

  const proc = spawnWithProgress(args, logStream, jobState, {
    denominator: seamlessLen,
    phase: 1,
    phaseLabel: 'Creating seamless unit',
    weight: { start: 0, end: 60 },
  });
  jobState.process = proc;

  proc.on('exit', (code, signal) => {
    logStream.write(`\n=== phase 1 exit code=${code} signal=${signal}\n`);
    if (jobState.cancelRequested || code !== 0 || signal) {
      return finishJob(ctx, code, signal);
    }
    if (!fs.existsSync(seamlessPath)) {
      logStream.write(`=== phase 1 finished but seamless file missing at ${seamlessPath}\n`);
      return finishJob(ctx, 1, null);
    }
    runSmoothPhase2(ctx);
  });
  proc.on('error', (err) => handleSpawnError(ctx, err));
}

function runSmoothPhase2(ctx) {
  const { target, outPath, logStream, jobState, seamlessPath,
          audioPath, audioVolume, audioMode } = ctx;

  const args = [
    '-hide_banner', '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-stream_loop', '-1',
    '-i', seamlessPath,
  ];

  if (audioPath) {
    args.push('-stream_loop', '-1', '-i', audioPath);
  }

  if (audioPath) {
    // Seamless unit may or may not have audio (depends on source). Check once.
    const seamlessHasAudio = probeHasAudio(seamlessPath);

    // Final loudness normalization to -14 LUFS (YouTube standard) followed
    // by alimiter brick-wall safety to catch peaks loudnorm misses.
    const masterFilter = 'loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=-1.5dB:level=disabled';

    if (audioMode === 'replace' || !seamlessHasAudio) {
      args.push(
        '-filter_complex', `[1:a]volume=${audioVolume},${masterFilter}[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    } else {
      args.push(
        '-filter_complex',
        `[0:a]volume=1.0[va];[1:a]volume=${audioVolume}[oa];[va][oa]amix=inputs=2:duration=first:dropout_transition=2,${masterFilter}[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    }
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    );
  } else {
    args.push(
      '-c', 'copy',
      '-map', '0:v:0', '-map', '0:a:0?',
    );
  }

  args.push(
    '-t', String(target),
    '-movflags', '+faststart',
    outPath,
  );

  logStream.write(`=== phase 2 (loop seamless unit) cmd: ffmpeg ${args.join(' ')}\n`);

  jobState.phase = 2;
  jobState.progress.phase = 2;
  jobState.progress.phaseLabel = 'Looping to target duration';

  const proc = spawnWithProgress(args, logStream, jobState, {
    denominator: target,
    phase: 2,
    phaseLabel: 'Looping to target duration',
    weight: { start: 60, end: 100 },
  });
  jobState.process = proc;

  proc.on('exit', (code, signal) => {
    logStream.write(`\n=== phase 2 exit code=${code} signal=${signal}\n`);
    finishJob(ctx, code, signal);
  });
  proc.on('error', (err) => handleSpawnError(ctx, err));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Spawn ffmpeg with -progress pipe:1 parsing. Progress updates jobState.progress
// with `percent` normalized to the weight range (so phase 1 can be 0-60 of the
// total bar, phase 2 can be 60-100).
function spawnWithProgress(args, logStream, jobState, { denominator, phase, phaseLabel, weight }) {
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === 'out_time_ms') {
        const ms = Number(v);
        if (Number.isFinite(ms) && ms > 0) {
          const t = ms / 1_000_000;
          jobState.progress.time = t;
          if (denominator > 0) {
            const raw = Math.min(1, t / denominator);
            const scaled = weight.start + raw * (weight.end - weight.start);
            jobState.progress.percent = Math.round(scaled);
          }
        }
      } else if (k === 'out_time') {
        const t = parseTime(v);
        if (t != null) {
          jobState.progress.time = t;
          if (denominator > 0) {
            const raw = Math.min(1, t / denominator);
            const scaled = weight.start + raw * (weight.end - weight.start);
            jobState.progress.percent = Math.round(scaled);
          }
        }
      } else if (k === 'speed') {
        const s = parseFloat(String(v).replace('x', ''));
        if (Number.isFinite(s)) jobState.progress.speed = s;
      }
    }
    jobState.progress.phase = phase;
    jobState.progress.phaseLabel = phaseLabel;
  });

  proc.stderr.on('data', (c) => logStream.write(c));
  return proc;
}

function finishJob(ctx, code, signal) {
  const { jobId, outPath, outputVideoId, logStream, jobState } = ctx;
  logStream.write(`\n=== ${new Date().toISOString()} job ${jobId} finished code=${code} signal=${signal}\n`);
  logStream.end();

  // Cleanup intermediate seamless file if present.
  if (ctx.seamlessPath && fs.existsSync(ctx.seamlessPath)) {
    try { fs.unlinkSync(ctx.seamlessPath); } catch (_) {}
  }

  jobs.delete(jobId);

  if (code === 0 && fs.existsSync(outPath)) {
    try {
      const size = fs.statSync(outPath).size;
      const actualDuration = transcoder.probeDuration(outPath) || ctx.target;
      db.prepare(`UPDATE videos
        SET status='ready', size_bytes=?, duration_seconds=?, last_error=NULL
        WHERE id=?`).run(size, actualDuration, outputVideoId);
      try {
        const thumb = transcoder.generateThumbnail(outPath, outputVideoId);
        if (thumb) {
          db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, outputVideoId);
        }
      } catch (_) {}
    } catch (e) {
      db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
        .run('post-process failed: ' + e.message, outputVideoId);
    }
  } else {
    if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (_) {}
    const msg = jobState.cancelRequested
      ? 'loop cancelled by user'
      : signal
        ? `loop cancelled (signal=${signal})`
        : `ffmpeg exited with code ${code} (see logs/loop-${jobId}.log)`;
    db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
      .run(msg, outputVideoId);
  }
}

function handleSpawnError(ctx, err) {
  const { jobId, logStream, outputVideoId } = ctx;
  logStream.write(`\n=== spawn error: ${err.message}\n`);
  logStream.end();
  if (ctx.seamlessPath && fs.existsSync(ctx.seamlessPath)) {
    try { fs.unlinkSync(ctx.seamlessPath); } catch (_) {}
  }
  db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
    .run(err.message, outputVideoId);
  jobs.delete(jobId);
}

function cancel(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) return false;
  j.cancelRequested = true;
  try { if (j.process) j.process.kill('SIGTERM'); } catch (_) {}
  return true;
}

function reconcileOnBoot() {
  // transcoder.reconcileOnBoot() flips stale 'transcoding' → 'error' already.
}

function tailLog(jobId, lines = 100) {
  const logPath = path.join(logsDir, `loop-${jobId}.log`);
  if (!fs.existsSync(logPath)) return '';
  const data = fs.readFileSync(logPath, 'utf8').split('\n');
  return data.slice(-lines).join('\n');
}

// Helpers -------------------------------------------------------------------

function uniqueVideoTitle(base) {
  const exists = (t) => db.prepare('SELECT 1 FROM videos WHERE title=?').get(t);
  if (!exists(base)) return base;
  const stripped = base.replace(/\s*\(\d+\)\s*$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stripped} (${i})`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function formatTargetLabel(seconds) {
  if (seconds >= 3600) {
    const h = seconds / 3600;
    return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
  }
  if (seconds >= 60) {
    const m = seconds / 60;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + 'm';
  }
  return seconds + 's';
}

function roundUpToLoopSafeTarget(targetSeconds, seamlessLen) {
  const target = Number(targetSeconds);
  const unit = Number(seamlessLen);
  if (!Number.isFinite(target) || !Number.isFinite(unit) || unit <= 0) return target;
  const repeats = Math.max(1, Math.ceil(target / unit));
  return Number((repeats * unit).toFixed(3));
}

// One-shot probe: does the file have an audio track? Uses transcoder.probeVideoInfo.
function probeHasAudio(filePath) {
  try {
    const info = transcoder.probeVideoInfo(filePath);
    return !!info.audioCodec;
  } catch (_) {
    return false;
  }
}

module.exports = {
  start,
  cancel,
  getProgress,
  isRunning,
  listJobs,
  getJob,
  reconcileOnBoot,
  tailLog,
  roundUpToLoopSafeTarget,
};
