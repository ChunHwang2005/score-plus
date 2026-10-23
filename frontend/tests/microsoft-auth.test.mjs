import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { API_URL } from '../lib/api.mjs';
import { clearStandaloneSession, isStandalone, loadStandaloneSession, microsoftLoginUrl } from '../lib/microsoft-auth.mjs';

const config = { clientId: 'client-1', tenantId: 'tenant-1', redirectUri: 'http://localhost:3000/' };

function fakeWindow(href = 'http://localhost:3000/') {
  const items = new Map();
  const win = {
    location: new URL(href),
    crypto: webcrypto,
    sessionStorage: { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)), removeItem: k => items.delete(k) },
    history: { replaceState: (_, __, url) => { win.location = new URL(url, win.location.origin); } },
    items,
  };
  win.parent = win;
  return win;
}

test('standalone only outside Portal embed path and outside an iframe', () => {
  assert.equal(isStandalone(fakeWindow()), true);
  assert.equal(isStandalone(fakeWindow('https://ai.neu.edu.vn/apps/embed/scoreplus/')), false);
  const framed = fakeWindow();
  framed.parent = {};
  assert.equal(isStandalone(framed), false);
});

test('login URL uses Web code flow with stored state', () => {
  const win = fakeWindow();
  const url = new URL(microsoftLoginUrl(win, config));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/');
  assert.equal(url.searchParams.get('state'), win.items.get('scoreplus_ms_oauth_state'));
  assert.throws(() => microsoftLoginUrl(win, { ...config, clientId: '' }), /NEXT_PUBLIC_MICROSOFT_CLIENT_ID/);
});

test('callback exchanges code via ScoreUp, strips URL and keeps token for the tab', async () => {
  const win = fakeWindow('http://localhost:3000/?code=abc&state=s1&session_state=x');
  win.items.set('scoreplus_ms_oauth_state', 's1');
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push([url, init]);
    if (url === `${API_URL}/auth/microsoft/code`) return new Response(JSON.stringify({ metadata: { token: 'tok' } }));
    return new Response(JSON.stringify({ metadata: { _id: 'u1', email: 's@neu.edu.vn' } }));
  };
  try {
    const session = await loadStandaloneSession({ win, config });
    assert.deepEqual(session, { token: 'tok', user: { _id: 'u1', email: 's@neu.edu.vn' } });
    assert.deepEqual(JSON.parse(calls[0][1].body), { code: 'abc', redirectUri: 'http://localhost:3000/' });
    assert.equal(calls[1][1].headers.Authorization, 'Bearer tok');
    assert.equal(win.location.search, '');
    assert.equal(win.items.get('scoreplus_scoreup_token'), 'tok');
    assert.equal(win.items.has('scoreplus_ms_oauth_state'), false);
  } finally { global.fetch = original; }
});

test('callback rejects mismatched state without calling ScoreUp', async () => {
  const win = fakeWindow('http://localhost:3000/?code=abc&state=forged');
  win.items.set('scoreplus_ms_oauth_state', 's1');
  const original = global.fetch;
  global.fetch = async () => { throw new Error('must not fetch'); };
  try { await assert.rejects(loadStandaloneSession({ win, config }), /không hợp lệ/); }
  finally { global.fetch = original; }
});

test('stored token: signed out when missing or rejected by ScoreUp', async () => {
  const win = fakeWindow();
  assert.equal(await loadStandaloneSession({ win, config }), null);
  win.items.set('scoreplus_scoreup_token', 'old');
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ status: 'ERROR' }), { status: 401 });
  try {
    assert.equal(await loadStandaloneSession({ win, config }), null);
    assert.equal(win.items.has('scoreplus_scoreup_token'), false);
  } finally { global.fetch = original; }
  win.items.set('scoreplus_scoreup_token', 'x');
  clearStandaloneSession(win);
  assert.equal(win.items.has('scoreplus_scoreup_token'), false);
});

test('Strict Mode double mount shares one code exchange', async () => {
  const win = fakeWindow('http://localhost:3000/api/auth/callback/azure-ad?code=abc&state=s1');
  win.items.set('scoreplus_ms_oauth_state', 's1');
  const original = global.fetch;
  let exchanges = 0;
  global.fetch = async (url) => {
    if (url === `${API_URL}/auth/microsoft/code`) { exchanges += 1; return new Response(JSON.stringify({ metadata: { token: 'tok' } })); }
    return new Response(JSON.stringify({ metadata: { _id: 'u1' } }));
  };
  try {
    // First mount starts the exchange and is torn down; second mount sees a clean URL.
    const first = loadStandaloneSession({ win, config });
    const second = await loadStandaloneSession({ win, config });
    await first;
    assert.equal(exchanges, 1);
    assert.equal(second?.token, 'tok');
  } finally { global.fetch = original; }
});
