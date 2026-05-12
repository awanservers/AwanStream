// Render every EJS template with both authed and anon locals to catch syntax
// / reference errors without booting the whole HTTP server.
const path = require('path');
const ejs = require('ejs');
const viewsDir = path.join(__dirname, '..', 'views');

const common = {
  formatTime: (v) => String(v || '-'),
  formatTimeShort: (v) => String(v || '-'),
  error: null,
  notice: null,
};

const pages = [
  {
    name: 'login',
    file: 'login.ejs',
    locals: { ...common, currentUser: null, error: null },
  },
  {
    name: 'setup',
    file: 'setup.ejs',
    locals: { ...common, currentUser: null, error: null, username: '' },
  },
  {
    name: 'dashboard',
    file: 'dashboard.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      videoCount: 2, readyCount: 1, streamCount: 1, runningCount: 0,
      pendingSchedules: 1, totalBytes: 150 * 1024 * 1024,
      recentStreams: [{ id: 1, name: 'demo', video_title: 'v1', platform: 'youtube',
        status: 'idle', started_at: null, stopped_at: null }],
      nextSchedule: { start_at: '2026-05-12T10:00:00.000Z', stream_name: 'demo' },
      system: { cpuPercent: 23, cpuCount: 4, loadAvg: [0.92, 0.85, 0.78], totalMem: 8*1024*1024*1024, usedMem: 3.2*1024*1024*1024, memPercent: 40, uptime: 86400*2 + 3600*5 + 60*30 },
    },
  },
  {
    name: 'videos',
    file: 'videos.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      videos: [{ id: 1, title: 't', filename: 'f.mp4', size_bytes: 1000000,
                 status: 'ready', last_error: null, created_at: '2026-05-11 10:00:00' }],
      presets: { '720p30': {}, '1080p30': {} },
    },
  },
  {
    name: 'streams-single',
    file: 'streams-single.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      streams: [{ id: 1, name: 's1', video_title: 'v1', platform: 'youtube',
                  status: 'idle', started_at: null, stopped_at: null, last_error: null }],
      videos: [{ id: 1, title: 'v1' }],
      presets: { youtube: 'rtmp://a.rtmp.youtube.com/live2', custom: '' },
    },
  },
  {
    name: 'streams-playlist',
    file: 'streams-playlist.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      streams: [{ id: 2, name: 's2', video_title: 'v1', playlist_name: 'My PL', platform: 'youtube',
                  status: 'idle', started_at: null, stopped_at: null, last_error: null }],
      playlists: [{ id: 1, name: 'My PL', item_count: 3 }],
      presets: { youtube: 'rtmp://a.rtmp.youtube.com/live2', custom: '' },
    },
  },
  {
    name: 'schedules',
    file: 'schedules.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      schedules: [{ id: 1, stream_name: 's1', video_title: 'v1',
                    start_at: '2026-05-11T12:00:00.000Z', stop_at: null,
                    status: 'pending', last_error: null }],
      streams: [{ id: 1, name: 's1' }],
      tzLabel: 'WIB',
    },
  },
  {
    name: 'error',
    file: 'error.ejs',
    locals: { ...common, currentUser: null, message: 'test error' },
  },
  {
    name: 'playlists',
    file: 'playlists.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      playlists: [{ id: 1, name: 'Test', item_count: 3, loop_playlist: 1, created_at: '2026-05-11 10:00:00' }],
      videos: [{ id: 1, title: 'v1' }],
    },
  },
  {
    name: 'playlist-detail',
    file: 'playlist-detail.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      playlist: { id: 1, name: 'Test', loop_playlist: 1 },
      items: [{ item_id: 1, position: 1, video_id: 1, title: 'v1', duration_seconds: 120 }],
      videos: [{ id: 1, title: 'v1' }],
    },
  },
];

let fail = 0;
for (const p of pages) {
  try {
    const out = ejs.render(
      require('fs').readFileSync(path.join(viewsDir, p.file), 'utf8'),
      p.locals,
      { filename: path.join(viewsDir, p.file) }
    );
    if (!out || out.length < 50) throw new Error('suspiciously short output: ' + out.length + ' chars');
    console.log('PASS', p.name, '(' + out.length + ' chars)');
  } catch (e) {
    fail++;
    console.error('FAIL', p.name, '—', e.message);
  }
}
process.exit(fail ? 1 : 0);
