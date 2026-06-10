// Render every EJS template with both authed and anon locals to catch syntax
// / reference errors without booting the whole HTTP server.
const path = require('path');
const ejs = require('ejs');
const viewsDir = path.join(__dirname, '..', 'views');

const common = {
  formatTime: (v) => String(v || '-'),
  formatTimeShort: (v) => String(v || '-'),
  appVersion: 'test',
  appBootedAt: '2026-05-11T10:00:00.000Z',
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
      system: {
        cpuPercent: 23, cpuCount: 4, loadAvg: [0.92, 0.85, 0.78],
        totalMem: 8*1024*1024*1024, usedMem: 3.2*1024*1024*1024,
        memPercent: 40, uptime: 86400*2 + 3600*5 + 60*30,
        disk: { total: 50*1024*1024*1024, used: 20*1024*1024*1024, free: 30*1024*1024*1024, percent: 40 },
        bandwidth: {
          available: true,
          rxBytes: 42 * 1024 * 1024 * 1024,
          txBytes: 128 * 1024 * 1024 * 1024,
          totalBytes: 170 * 1024 * 1024 * 1024,
        },
      },
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
      presets: { '720p30': { br: '4500k' }, '720p60': { br: '7500k' }, '1080p30': { br: '8000k' }, '1080p60': { br: '12000k' }, '720p30-low': { br: '2500k' }, '1080p30-low': { br: '4500k' } },
      youtubeConnected: false,
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
      audioFiles: [{ id: 2, title: 'Jazz BGM', duration_seconds: 300 }],
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
      audioFiles: [{ id: 2, title: 'Jazz BGM', duration_seconds: 300 }],
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
  {
    name: 'looper',
    file: 'looper.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      videos: [{
        id: 1, title: 'Fireplace clip', filename: 'f.mp4',
        duration_seconds: 12, src_width: 1920, src_height: 1080,
        size_bytes: 2_500_000, thumbnail: null, status: 'ready',
        folder_id: null, created_at: '2026-05-11 10:00:00',
      }],
      presets: [
        { key: '30m',  label: '30 minutes', seconds: 1800 },
        { key: '1h',   label: '1 hour',     seconds: 3600 },
        { key: '2h',   label: '2 hours',    seconds: 7200 },
        { key: '3h',   label: '3 hours',    seconds: 10800 },
        { key: '6h',   label: '6 hours',    seconds: 21600 },
        { key: '12h',  label: '12 hours',   seconds: 43200 },
        { key: '24h',  label: '24 hours',   seconds: 86400 },
      ],
      activeJobs: [],
      audioTracks: [{ id: 1, title: 'Night Jazz', duration_seconds: 180 }],
    },
  },
  {
    name: 'audio',
    file: 'audio.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      tracks: [{
        id: 1, title: 'Night Jazz', filename: '1_night.mp3',
        size_bytes: 4_500_000, duration_seconds: 180, codec: 'mp3',
        bitrate: 192000, sample_rate: 44100, channels: 2,
        status: 'uploaded', last_error: null,
        created_at: '2026-05-13 10:00:00',
      }],
    },
  },
  {
    name: 'youtube-not-configured',
    file: 'youtube.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      configured: false,
      status: { connected: false, configured: false },
    },
  },
  {
    name: 'youtube-not-connected',
    file: 'youtube.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      configured: true,
      status: { connected: false, configured: true },
    },
  },
  {
    name: 'youtube-connected',
    file: 'youtube.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      configured: true,
      status: {
        connected: true, configured: true,
        channelId: 'UCabcdef123', channelTitle: 'My Cozy Channel',
        connectedAt: '2026-05-14 10:00:00',
      },
    },
  },
  {
    name: 'profile',
    file: 'profile.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      user: {
        id: 1, username: 'admin',
        created_at: '2026-05-11 10:00:00',
        last_login_at: '2026-05-19 08:30:00',
        last_login_ip: '127.0.0.1',
      },
      stats: {
        videos: 12,
        streamSessions: 47,
        streamSeconds: 36 * 3600 + 25 * 60,
        runningStreams: 1,
        storageBytes: 4.2 * 1024 * 1024 * 1024,
      },
      youtube: {
        connected: true,
        channelTitle: 'My Cozy Channel',
        channelId: 'UCabc',
        connectedAt: '2026-05-14 10:00:00',
      },
    },
  },
  {
    name: 'users',
    file: 'users.ejs',
    locals: {
      ...common,
      currentUser: { id: 1, username: 'admin' },
      users: [
        { id: 1, username: 'admin', created_at: '2026-05-11 10:00:00' },
        { id: 2, username: 'partner', created_at: '2026-05-15 11:00:00' },
      ],
      totalUsers: 2,
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
