import { request } from './api.mjs';
import { unwrap } from './practice.mjs';

export function portalApiPath(path, win = window) {
  const injectedBase = String(win.__PORTAL_BASE_PATH__ || '').replace(/\/+$/, '');
  const embedMatch = win.location.pathname.match(/^(.*)\/embed\/scoreplus(?:\/|$)/);
  return `${injectedBase || embedMatch?.[1] || ''}${path}`;
}

function normalizeUser(value) {
  if (!value || typeof value.id !== 'string' || !value.id.trim()) return null;
  return { id: value.id, email: typeof value.email === 'string' ? value.email : '', name: typeof value.name === 'string' ? value.name : '' };
}

export async function loadPortalUser({ signal, win = window } = {}) {
  const response = await fetch(new URL(portalApiPath('/api/auth/session', win), win.location.origin).href, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Không tải được phiên AI-Portal (${response.status}). Hãy mở công cụ từ Portal.`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI-Portal trả về phiên không hợp lệ.');
  if (!data.user) return null;
  const user = normalizeUser(data.user);
  if (!user) throw new Error('Phiên AI-Portal thiếu mã người dùng.');
  if (data.expires && (!Number.isFinite(Date.parse(data.expires)) || Date.parse(data.expires) <= Date.now())) return null;
  // Retain only display context. accessToken is the OAuth provider token,
  // not a ScoreUp session; image/profile/admin fields are not needed here.
  return user;
}

// Portal user context is for display only, never a ScoreUp credential.
export function subscribePortalUser(win, onUser, onTheme) {
  const onMessage = event => {
    if (event.source !== win.parent || event.origin !== win.location.origin) return;
    if (event.data?.type === 'PORTAL_USER') onUser(normalizeUser(event.data.user));
    if (event.data?.type === 'portal-theme' && ['dark', 'light'].includes(event.data.theme)) onTheme(event.data.theme);
  };
  win.addEventListener('message', onMessage);
  if (win.__PORTAL_USER__) onUser(normalizeUser(win.__PORTAL_USER__));
  if (['dark', 'light'].includes(win.__PORTAL_THEME__)) onTheme(win.__PORTAL_THEME__);
  if (win.parent !== win) win.parent.postMessage({ type: 'PORTAL_APP_NEED_USER' }, win.location.origin);
  return () => win.removeEventListener('message', onMessage);
}

export async function loadPortalScoreupSession({ path, signal, win = window }) {
  // Only send Portal cookies to its own origin. The endpoint must verify the
  // cookie server-side and issue a ScoreUp token for that authenticated user.
  if (!path?.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#]/.test(path)) {
    throw new Error('Cần cấu hình NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH là path endpoint SSO của AI-Portal (bắt đầu bằng /, không gồm base path).');
  }
  const url = new URL(portalApiPath(path, win), win.location.origin);
  if (url.origin !== win.location.origin) throw new Error('Endpoint SSO phải cùng origin với AI-Portal.');
  const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status === 'ERROR') {
    const error = new Error(response.status === 401 ? 'Phiên AI-Portal đã hết hạn. Hãy mở lại công cụ từ Portal.' : data?.message || `Không lấy được phiên ScoreUp (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const token = unwrap(data)?.token;
  if (typeof token !== 'string' || !token.trim()) throw new Error('Endpoint SSO chưa trả về token ScoreUp hợp lệ.');
  return withScoreupUser(token, signal);
}

async function withScoreupUser(token, signal) {
  const user = unwrap(await request('/user/info', { token, signal }));
  if (!user?._id && !user?.id) throw new Error('Không tải được tài khoản ScoreUp liên kết.');
  return { token, user };
}

/**
 * Dự phòng khi Portal chưa có endpoint SSO: dùng access token Microsoft trong phiên Portal
 * (user đăng nhập Portal bằng Microsoft). ScoreUp xác minh token với Microsoft Graph, kiểm
 * đúng tenant + app Azure, rồi cấp token ScoreUp. Token Microsoft chỉ dùng cho lần đổi này.
 */
export async function loadPortalMicrosoftSession({ signal, win = window }) {
  const response = await fetch(new URL(portalApiPath('/api/auth/session', win), win.location.origin).href, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  const data = response.ok ? await response.json().catch(() => null) : null;
  if (!data?.user) {
    const error = new Error('Phiên AI-Portal đã hết hạn. Hãy mở lại công cụ từ Portal.');
    error.status = 401;
    throw error;
  }
  if (typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new Error('Hãy đăng nhập AI-Portal bằng tài khoản Microsoft NEU để dùng ScorePlus.');
  }
  let result;
  try {
    result = await request('/auth/microsoft/token', { body: { accessToken: data.accessToken }, signal });
  } catch (e) {
    if (e.status === 401) {
      const error = new Error('Phiên Microsoft trên AI-Portal đã hết hạn. Hãy đăng xuất và đăng nhập lại AI-Portal.');
      error.status = 401;
      throw error;
    }
    throw e;
  }
  const token = unwrap(result)?.token;
  if (typeof token !== 'string' || !token) throw new Error('ScoreUp không trả về token đăng nhập.');
  return withScoreupUser(token, signal);
}

/** Endpoint SSO của Portal trước; Portal chưa có (404/5xx/chưa cấu hình) thì dùng token Microsoft. */
export async function loadScoreupSessionFromPortal({ path, signal, win = window }) {
  try {
    return await loadPortalScoreupSession({ path, signal, win });
  } catch (e) {
    if (e.status === 401 || e.name === 'AbortError' || signal?.aborted) throw e;
    return loadPortalMicrosoftSession({ signal, win });
  }
}
