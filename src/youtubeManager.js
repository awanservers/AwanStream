// YouTube account manager — OAuth2 flow + token storage.
//
// Phase 1 scope:
//   - OAuth2 authorization URL generation
//   - Token exchange (auth code → access/refresh token)
//   - Token storage in SQLite (single-account model for now)
//   - Token refresh (auto when expired)
//   - Channel info fetch (so we can show "connected as <Channel Name>")
//   - Disconnect (revoke token + clear DB)
//
// Phase 2 (later) will add upload functionality.
const { google } = require('googleapis');
const { db } = require('./db');

// OAuth2 scopes — minimum needed for upload.
// `youtube.upload`  → upload videos (private/unlisted/public)
// `youtube.readonly` → read channel info (so we can show "connected as <name>")
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

/**
 * Build OAuth2 client from env credentials.
 * Required env vars:
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REDIRECT_URI  — must match exactly what's set in Google Cloud Console
 */
function buildOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'YouTube OAuth credentials not configured. ' +
      'Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI in .env. ' +
      'See docs/youtube-setup.md for details.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Check if OAuth credentials are configured (for UI guard).
 */
function isConfigured() {
  return !!(
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REDIRECT_URI
  );
}

/**
 * Generate the authorization URL for the user to visit.
 * `prompt=consent` ensures we always get a refresh_token (Google only sends
 * it on first consent unless we force re-consent).
 */
function getAuthUrl() {
  const oauth2 = buildOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    include_granted_scopes: true,
  });
}

/**
 * Exchange an authorization code (from OAuth callback) for tokens, fetch
 * channel info, and persist to DB.
 */
async function exchangeCodeAndStore(code) {
  const oauth2 = buildOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Fetch channel info so we can label the account.
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const channelResp = await youtube.channels.list({
    part: ['id', 'snippet'],
    mine: true,
  });

  const channel = channelResp.data.items && channelResp.data.items[0];
  const channelId = channel ? channel.id : null;
  const channelTitle = channel && channel.snippet ? channel.snippet.title : null;

  // Persist. We treat it as single-account: clear any existing row first.
  db.prepare('DELETE FROM youtube_accounts').run();
  db.prepare(`INSERT INTO youtube_accounts
    (channel_id, channel_title, access_token, refresh_token, token_type, scope, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    channelId,
    channelTitle,
    tokens.access_token || null,
    tokens.refresh_token || null,
    tokens.token_type || 'Bearer',
    Array.isArray(tokens.scope) ? tokens.scope.join(' ') : (tokens.scope || SCOPES.join(' ')),
    tokens.expiry_date || null,
  );

  return { channelId, channelTitle };
}

/**
 * Get the currently-connected account row from DB, or null.
 */
function getAccount() {
  return db.prepare('SELECT * FROM youtube_accounts ORDER BY id DESC LIMIT 1').get() || null;
}

/**
 * Build an authenticated OAuth2 client from the stored credentials.
 * Returns null if no account connected. Auto-refreshes access_token
 * via googleapis (the library handles refresh transparently when
 * a refresh_token is present and expiry_date has passed).
 */
function getAuthedClient() {
  const acc = getAccount();
  if (!acc || !acc.refresh_token) return null;

  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({
    access_token: acc.access_token,
    refresh_token: acc.refresh_token,
    token_type: acc.token_type || 'Bearer',
    scope: acc.scope,
    expiry_date: acc.expiry_date,
  });

  // Persist refreshed tokens back to DB whenever the library refreshes them.
  oauth2.on('tokens', (newTokens) => {
    try {
      const stmt = db.prepare(`UPDATE youtube_accounts SET
        access_token = COALESCE(?, access_token),
        refresh_token = COALESCE(?, refresh_token),
        expiry_date = COALESCE(?, expiry_date),
        scope = COALESCE(?, scope),
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`);
      stmt.run(
        newTokens.access_token || null,
        newTokens.refresh_token || null,
        newTokens.expiry_date || null,
        Array.isArray(newTokens.scope) ? newTokens.scope.join(' ') : (newTokens.scope || null),
        acc.id,
      );
    } catch (_) { /* non-critical */ }
  });

  return oauth2;
}

/**
 * Quick connection status check — useful for UI badges.
 */
function getStatus() {
  const acc = getAccount();
  if (!acc) return { connected: false, configured: isConfigured() };
  return {
    connected: true,
    configured: true,
    channelId: acc.channel_id,
    channelTitle: acc.channel_title,
    connectedAt: acc.created_at,
  };
}

/**
 * Disconnect: revoke the refresh_token at Google and clear DB.
 * If revocation fails (network / already revoked), still clear local DB
 * so user can re-connect.
 */
async function disconnect() {
  const acc = getAccount();
  if (!acc) return { ok: true, alreadyDisconnected: true };

  let revokeError = null;
  if (acc.refresh_token) {
    try {
      const oauth2 = buildOAuthClient();
      oauth2.setCredentials({ refresh_token: acc.refresh_token });
      await oauth2.revokeToken(acc.refresh_token);
    } catch (e) {
      // Token may already be invalid — that's fine, we still want to clear DB.
      revokeError = e.message;
    }
  }

  db.prepare('DELETE FROM youtube_accounts').run();
  return { ok: true, revokeError };
}

function reconcileOnBoot() {
  // Nothing to reconcile yet. Phase 2 will reset stale upload jobs here.
}

module.exports = {
  SCOPES,
  isConfigured,
  getAuthUrl,
  exchangeCodeAndStore,
  getAccount,
  getAuthedClient,
  getStatus,
  disconnect,
  reconcileOnBoot,
};
