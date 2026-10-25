import { request } from './api.mjs';
import { unwrap } from './practice.mjs';

// Standalone (not served under AI-Portal's /embed/scoreplus): sign in with
// Microsoft the same way ScoreUp does — Web-app authorization code flow, the
// code is exchanged by ScoreUp BE (POST /auth/microsoft/code) for a ScoreUp token.
const STATE_KEY = 'scoreplus_ms_oauth_state';
const TOKEN_KEY = 'scoreplus_scoreup_token';

export function isStandalone(win = window) {
  return win.parent === win && !/\/embed\/scoreplus(?:\/|$)/.test(win.location.pathname);
}

// Next only inlines NEXT_PUBLIC_* when written literally, so list them here.
const BUILD_ENV = {
  NEXT_PUBLIC_MICROSOFT_CLIENT_ID: process.env.NEXT_PUBLIC_MICROSOFT_CLIENT_ID,
  NEXT_PUBLIC_MICROSOFT_TENANT_ID: process.env.NEXT_PUBLIC_MICROSOFT_TENANT_ID,
  NEXT_PUBLIC_MICROSOFT_REDIRECT_URI: process.env.NEXT_PUBLIC_MICROSOFT_REDIRECT_URI,
};

export function microsoftConfig(win = window, env = BUILD_ENV) {
  return {
    clientId: env.NEXT_PUBLIC_MICROSOFT_CLIENT_ID || '',
    tenantId: env.NEXT_PUBLIC_MICROSOFT_TENANT_ID || '',
    // Must be registered in Azure (Authentication → Web → Redirect URIs) exactly as sent.
    redirectUri: env.NEXT_PUBLIC_MICROSOFT_REDIRECT_URI || `${win.location.origin}/`,
  };
}

function storage(win, name) {
  try { return win[name]; } catch { return null; }
}

function randomState(win) {
  const bytes = new Uint8Array(24);
  win.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function microsoftLoginUrl(win = window, config = microsoftConfig(win)) {
  if (!config.clientId || !config.tenantId) {
    throw new Error('Chưa cấu hình NEXT_PUBLIC_MICROSOFT_CLIENT_ID / NEXT_PUBLIC_MICROSOFT_TENANT_ID cho đăng nhập Microsoft.');
  }
  const state = randomState(win);
  storage(win, 'sessionStorage')?.setItem(STATE_KEY, state);
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile email User.Read');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.href;
}

/** Remove OAuth params from the address bar so a refresh does not replay the code. */
function clearCallbackParams(win) {
  const url = new URL(win.location.href);
  for (const key of ['code', 'state', 'session_state', 'error', 'error_description', 'error_uri']) url.searchParams.delete(key);
  win.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/**
 * Resolve the standalone ScoreUp session: finish a Microsoft redirect if the URL
 * carries one, otherwise reuse the token kept for this tab. Returns null when signed out.
 */
// The code exchange runs once per page load and is not tied to a component's
// AbortSignal: React Strict Mode mounts effects twice in dev, and aborting the
// first exchange would burn the one-time code (the URL is already cleared).
let pendingExchange = null;

async function exchangeCode(config, params, store) {
  const expected = store?.getItem(STATE_KEY);
  store?.removeItem(STATE_KEY);
  if (params.has('error')) throw new Error(params.get('error_description') || 'Đăng nhập Microsoft thất bại.');
  if (!expected || params.get('state') !== expected) throw new Error('Trạng thái đăng nhập không hợp lệ. Hãy đăng nhập lại.');
  const data = await request('/auth/microsoft/code', { body: { code: params.get('code'), redirectUri: config.redirectUri } });
  const token = unwrap(data)?.token;
  if (typeof token !== 'string' || !token) throw new Error('ScoreUp không trả về token đăng nhập.');
  store?.setItem(TOKEN_KEY, token);
}

export async function loadStandaloneSession({ signal, win = window, config = microsoftConfig(win) } = {}) {
  const params = new URLSearchParams(win.location.search);
  const store = storage(win, 'sessionStorage');
  if (params.has('code') || params.has('error')) {
    clearCallbackParams(win);
    pendingExchange = exchangeCode(config, params, store);
    pendingExchange.catch(() => {}).finally(() => { pendingExchange = null; });
  }
  if (pendingExchange) await pendingExchange;
  const token = store?.getItem(TOKEN_KEY) || '';
  if (!token) return null;
  try {
    const user = unwrap(await request('/user/info', { token, signal }));
    if (!user?._id && !user?.id) throw new Error('Không tải được tài khoản ScoreUp.');
    return { token, user };
  } catch (e) {
    if (e.status === 401) { store?.removeItem(TOKEN_KEY); return null; }
    throw e;
  }
}

export function clearStandaloneSession(win = window) {
  storage(win, 'sessionStorage')?.removeItem(TOKEN_KEY);
}
