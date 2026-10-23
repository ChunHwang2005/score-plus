import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPortalScoreupSession, loadPortalUser, portalApiPath, subscribePortalUser } from '../lib/portal-auth.mjs';

function fakeWindow() {
  const listeners = new Set();
  const sent = [];
  return {
    location: { origin: 'https://portal.example', pathname: '/apps/embed/scoreplus/' },
    parent: { postMessage: (...args) => sent.push(args) },
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    emit(event) { for (const listener of listeners) listener(event); },
    sent,
  };
}

test('Portal session API uses base path/cookies and retains only display identity', async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://portal.example/apps/api/auth/session');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers, undefined);
    return new Response(JSON.stringify({
      user: { id: 'p1', email: 'student@example.com', name: 'Student', is_admin: true, profile: { provider: 'azure-ad' }, image: 'image' },
      accessToken: 'provider-token-must-not-be-used-for-scoreup',
      expires: '2099-01-01T00:00:00.000Z',
    }));
  };
  try { assert.deepEqual(await loadPortalUser({ win: fakeWindow() }), { id: 'p1', email: 'student@example.com', name: 'Student' }); }
  finally { global.fetch = original; }
});

test('Portal session API handles signed out, expiry and invalid responses', async () => {
  const original = global.fetch;
  try {
    for (const payload of [{}, { user: null }, { user: { id: 'p1' }, expires: '2000-01-01T00:00:00Z' }]) {
      global.fetch = async () => new Response(JSON.stringify(payload));
      assert.equal(await loadPortalUser({ win: fakeWindow() }), null);
    }
    global.fetch = async () => new Response('{}', { status: 401 });
    assert.equal(await loadPortalUser({ win: fakeWindow() }), null);
    global.fetch = async () => new Response(JSON.stringify({ user: { email: 'no-id@example.com' } }));
    await assert.rejects(loadPortalUser({ win: fakeWindow() }), /mã người dùng/);
    global.fetch = async () => new Response('<html>Not found</html>');
    await assert.rejects(loadPortalUser({ win: fakeWindow() }), /không hợp lệ/);
    global.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(loadPortalUser({ win: fakeWindow() }), /503/);
  } finally { global.fetch = original; }
});

test('Portal handshake receives injected user, rejects foreign messages, handles logout and cleanup', () => {
  const win = fakeWindow();
  win.__PORTAL_USER__ = { id: 'p1', name: 'Student', token: 'never-use-this' };
  const users = [];
  const themes = [];
  const unsubscribe = subscribePortalUser(win, value => users.push(value), value => themes.push(value));
  assert.deepEqual(users, [{ id: 'p1', name: 'Student', email: '' }]);
  assert.deepEqual(win.sent, [[{ type: 'PORTAL_APP_NEED_USER' }, win.location.origin]]);
  const data = { type: 'PORTAL_USER', user: { id: 'p2' } };
  win.emit({ source: {}, origin: win.location.origin, data });
  win.emit({ source: win.parent, origin: 'https://foreign.example', data });
  assert.equal(users.length, 1);
  win.emit({ source: win.parent, origin: win.location.origin, data });
  assert.equal(users[1].id, 'p2');
  win.emit({ source: win.parent, origin: win.location.origin, data: { type: 'PORTAL_USER', user: null } });
  assert.equal(users[2], null);
  win.emit({ source: win.parent, origin: win.location.origin, data: { type: 'portal-theme', theme: 'dark' } });
  assert.deepEqual(themes, ['dark']);
  unsubscribe();
  win.emit({ source: win.parent, origin: win.location.origin, data });
  assert.equal(users.length, 3);
});

test('Portal API respects injected and inferred base paths', () => {
  const win = fakeWindow();
  assert.equal(portalApiPath('/api/session', win), '/apps/api/session');
  win.__PORTAL_BASE_PATH__ = '/portal/';
  assert.equal(portalApiPath('/api/session', win), '/portal/api/session');
  delete win.__PORTAL_BASE_PATH__;
  win.location.pathname = '/';
  assert.equal(portalApiPath('/api/session', win), '/api/session');
});

test('SSO uses Portal cookie then verifies ScoreUp bearer without sending identity from browser', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(calls.length === 1 ? { metadata: { token: 'scoreup-token' } } : { metadata: { _id: 's1', email: 'student@example.com' } }));
  };
  try {
    const session = await loadPortalScoreupSession({ path: '/api/scoreplus/session', win: fakeWindow() });
    assert.equal(session.user._id, 's1');
    assert.equal(calls[0].url, 'https://portal.example/apps/api/scoreplus/session');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.body, undefined);
    assert.ok(calls[1].url.endsWith('/user/info'));
    assert.equal(calls[1].init.headers.Authorization, 'Bearer scoreup-token');
    assert.equal(calls[1].init.credentials, 'omit');
  } finally { global.fetch = original; }
});

test('SSO refuses missing/foreign paths, missing token and invalid ScoreUp session', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => { throw new Error('must not fetch'); };
    for (const path of ['', 'https://foreign.example/session', '//foreign.example/session', '/\\foreign.example', '/api/session?token=x']) {
      await assert.rejects(loadPortalScoreupSession({ path, win: fakeWindow() }), /cấu hình/);
    }
    global.fetch = async () => new Response(JSON.stringify({ id: 'portal-user' }));
    await assert.rejects(loadPortalScoreupSession({ path: '/api/session', win: fakeWindow() }), /token ScoreUp/);
    let calls = 0;
    global.fetch = async () => ++calls === 1
      ? new Response(JSON.stringify({ token: 'invalid' }))
      : new Response('{}', { status: 401 });
    await assert.rejects(loadPortalScoreupSession({ path: '/api/session', win: fakeWindow() }), error => error.status === 401);
  } finally { global.fetch = original; }
});
