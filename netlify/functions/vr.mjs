const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function getEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function joinUrl(base, path) {
  const baseStr = String(base || '').trim();
  const pathStr = String(path || '').trim();
  return new URL(pathStr, baseStr.endsWith('/') ? baseStr : `${baseStr}/`).toString();
}

let cachedAccessToken = '';
let cachedTokenExpiresAtMs = 0;
let tokenFetchPromise = null;

async function fetchAccessToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedAccessToken && now < cachedTokenExpiresAtMs) return cachedAccessToken;

  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    const serverUrl = getEnv('KEYCLOAK_SERVER_URL');
    const realm = getEnv('KEYCLOAK_REALM');
    const clientId = getEnv('KEYCLOAK_CLIENT_ID');
    const clientSecret = getEnv('KEYCLOAK_CLIENT_SECRET');

    const tokenUrl = joinUrl(serverUrl, `/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`);
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!resp.ok) {
      const msg = data?.error_description || data?.error || text?.slice(0, 300) || `HTTP ${resp.status}`;
      throw new Error(`Keycloak token fetch failed: ${resp.status} ${msg}`);
    }

    const accessToken = String(data?.access_token || '').trim();
    const expiresIn = Number(data?.expires_in || 0);
    if (!accessToken) throw new Error('Keycloak token response missing access_token');

    const safetyMs = 30_000;
    const ttlMs = Math.max(5_000, expiresIn * 1000 - safetyMs);
    cachedAccessToken = accessToken;
    cachedTokenExpiresAtMs = Date.now() + ttlMs;
    return accessToken;
  })();

  try {
    return await tokenFetchPromise;
  } finally {
    tokenFetchPromise = null;
  }
}

async function callVrApi(path, { method = 'GET', body = null } = {}) {
  const baseUrl = getEnv('VR_API_BASE_URL');
  const url = joinUrl(baseUrl, path);

  async function attempt({ refresh } = {}) {
    const token = await fetchAccessToken({ forceRefresh: Boolean(refresh) });
    const headers = { Authorization: `Bearer ${token}` };
    let payload = undefined;
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return fetch(url, { method, headers, body: payload });
  }

  let resp = await attempt({ refresh: false });
  if (resp.status === 401 || resp.status === 403) {
    resp = await attempt({ refresh: true });
  }
  return resp;
}

function parseSubpath(event) {
  const fullPath = String(event?.path || '').trim();
  const prefix = '/.netlify/functions/vr';
  if (fullPath.startsWith(prefix)) return fullPath.slice(prefix.length) || '/';
  return fullPath || '/';
}

export async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

    const subpath = parseSubpath(event);
    const method = String(event.httpMethod || 'GET').toUpperCase();

    if (method === 'POST' && subpath === '/session/start') {
      let payload = {};
      try {
        payload = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { ok: false, error: 'Invalid JSON body' });
      }

      const resp = await callVrApi('/api/v1/vr/session/start', { method: 'POST', body: payload });
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!resp.ok) return json(resp.status, { ok: false, error: data });
      return json(200, { ok: true, data });
    }

    if (method === 'POST' && subpath === '/session/complete') {
      let payload = {};
      try {
        payload = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { ok: false, error: 'Invalid JSON body' });
      }

      const resp = await callVrApi('/api/v1/vr/session/complete', { method: 'POST', body: payload });
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!resp.ok) return json(resp.status, { ok: false, error: data });
      return json(200, { ok: true, data });
    }

    if (method === 'GET' && subpath === '/sessions') {
      const resp = await callVrApi('/api/v1/vr/sessions', { method: 'GET' });
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!resp.ok) return json(resp.status, { ok: false, error: data });
      return json(200, { ok: true, data });
    }

    return json(404, {
      ok: false,
      error: 'Not found. Use POST /.netlify/functions/vr/session/start, POST /.netlify/functions/vr/session/complete, or GET /.netlify/functions/vr/sessions',
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

