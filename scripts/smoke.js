// Smoke test: ensure schema + modules load + views render.
require('dotenv').config();
const { ensureSchema } = require('../src/db');
ensureSchema();
console.log('schema OK');
require('../src/streamManager');
require('../src/transcoder');
require('../src/downloader');
require('../src/scheduler');
require('../src/looper');
require('../src/auth');
require('../src/routes/auth');
require('../src/routes/videos');
require('../src/routes/streams');
require('../src/routes/schedules');
require('../src/routes/looper');
console.log('modules OK');
require('./render-check');
