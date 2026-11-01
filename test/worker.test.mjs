// 模板广场 Worker（全 Cloudflare 版，2026-11-01）：公开 /library.json + /submit，管理 /admin + /admin/api/*。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.js';
import { ADMIN_HTML } from '../worker/admin-page.js';

// 内存版 KV：get / put / delete / list({prefix, cursor})；忽略 TTL（只记下来供断言）。
function kv() {
    const m = new Map();
    const ttl = new Map();
    return {
        _m: m, _ttl: ttl,
        get: async (k) => (m.has(k) ? m.get(k) : null),
        put: async (k, v, o) => { m.set(k, String(v)); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); },
        delete: async (k) => { m.delete(k); },
        list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }),
    };
}
const ADMIN = 'correct-horse-battery-staple-42';
const env = (over = {}) => ({ HUB: kv(), SALT: 's', ADMIN_TOKEN: ADMIN, ...over });
const good = { name: '中译日', prompt: '把正文翻译成日文。', tags: ['翻译'], client: '1.90.0' };
let clock = Date.parse('2026-11-01T10:00:00Z');
const deps = () => ({ now: () => new Date(clock) });
const call = (e, path, { method = 'GET', body, ip = '1.2.3.4', auth } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth !== undefined) headers.Authorization = auth;
    return handle(new Request('https://hub.test' + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), e, deps());
};
const submit = (e, body = good, ip) => call(e, '/submit', { method: 'POST', body, ip });
const admin = (e, op, body) => call(e, '/admin/api/' + op, { method: body ? 'POST' : 'GET', body, auth: 'Bearer ' + ADMIN });
const lib = async (e) => (await call(e, '/library.json')).json();

test.beforeEach(() => { clock += 60000; });

/* ---------- 公开：库 ---------- */

test('empty library: same shape as 1.86.0 dist/library.json, CORS, short cache', async () => {
    const r = await call(env(), '/library.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(r.headers.get('Cache-Control'), /max-age=60/);
    const j = await r.json();
    assert.equal(j.schema, 1);
    assert.ok(Array.isArray(j.tags) && j.tags.includes('翻译'));
    assert.deepEqual(j.templates, []);
    assert.ok(!Number.isNaN(Date.parse(j.generatedAt)));
});

test('OPTIONS preflight on public routes → 204 + CORS', async () => {
    for (const p of ['/submit', '/library.json']) {
        const r = await call(env(), p, { method: 'OPTIONS' });
        assert.equal(r.status, 204);
        assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    }
});

test('unknown route → 404; wrong method → 405', async () => {
    assert.equal((await call(env(), '/x')).status, 404);
    assert.equal((await call(env(), '/submit')).status, 405);
    assert.equal((await call(env(), '/library.json', { method: 'POST', body: {} })).status, 405);
});

/* ---------- 公开：投稿 ---------- */

test('submit → pending, not public; reply carries a ref', async () => {
    const e = env();
    const r = await submit(e);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.ref, /^s[0-9a-z]+$/);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual((await lib(e)).templates, [], 'nothing public before approval');
    const stored = JSON.parse(e.HUB._m.get('sub:' + j.ref));
    assert.equal(stored.value.name, '中译日');
});

test('submit: bad JSON / too large / invalid fields', async () => {
    const e = env();
    assert.equal((await submit(e, '{nope')).status, 400);
    assert.equal((await submit(e, 'x'.repeat(70000))).status, 413);
    const r = await submit(e, { ...good, tags: ['不存在的标签'] });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid');
    assert.ok(j.errors.some((x) => x.field === 'tags'));
});

test('submit: update of an unknown template id is rejected up front', async () => {
    const r = await submit(env(), { ...good, updateOf: 't0099' });
    assert.equal(r.status, 400);
    assert.ok((await r.json()).errors.some((x) => x.code === 'unknown_update'));
});

test('rate limit: 5 per IP per day, other IPs unaffected; IP never stored in clear', async () => {
    const e = env();
    for (let i = 0; i < 5; i++) assert.equal((await submit(e, good, '9.9.9.9')).status, 200);
    assert.equal((await submit(e, good, '9.9.9.9')).status, 429);
    assert.equal((await submit(e, good, '8.8.8.8')).status, 200);
    const keys = [...e.HUB._m.keys()];
    assert.ok(keys.every((k) => !k.includes('9.9.9.9')));
    const rl = keys.filter((k) => k.startsWith('rl:'));
    assert.ok(rl.length === 2 && rl.every((k) => e.HUB._ttl.get(k) === 86400));
});

test('queue cap: 300 pending → 503 queue_full', async () => {
    const e = env();
    for (let i = 0; i < 300; i++) e.HUB._m.set('sub:sfake' + String(i).padStart(4, '0'), '{}');
    const r = await submit(e);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'queue_full');
});

/* ---------- 管理：鉴权 ---------- */

test('admin API: no / wrong password → 401; 20 failures → locked 429 even with the right password', async () => {
    const e = env();
    assert.equal((await call(e, '/admin/api/pending')).status, 401);   // 失败 #1（没带密码也算）
    for (let i = 0; i < 18; i++) await call(e, '/admin/api/pending', { auth: 'Bearer nope' });   // #2–#19
    assert.equal((await call(e, '/admin/api/pending', { auth: 'Bearer nope' })).status, 401);
    assert.equal((await admin(e, 'pending')).status, 429);
    assert.equal((await call(e, '/admin/api/pending', { auth: 'Bearer ' + ADMIN, ip: '5.5.5.5' })).status, 200, 'other IPs not locked');
});

test('admin API refuses to run without a real ADMIN_TOKEN configured', async () => {
    assert.equal((await admin(env({ ADMIN_TOKEN: '' }), 'pending')).status, 503);
    assert.equal((await admin(env({ ADMIN_TOKEN: 'short' }), 'pending')).status, 503);
});

test('admin responses are never CORS-enabled', async () => {
    const r = await admin(env(), 'pending');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

/* ---------- 管理：审核流程 ---------- */

test('approve → public as t0001 v1; queue empties; double approve refused', async () => {
    const e = env();
    const { ref } = await (await submit(e)).json();
    const pend = await (await admin(e, 'pending')).json();
    assert.equal(pend.pending.length, 1);
    assert.equal(pend.pending[0].ref, ref);
    const a = await (await admin(e, 'approve', { ref })).json();
    assert.deepEqual(a, { ok: true, id: 't0001', version: 1 });
    const l = await lib(e);
    assert.equal(l.templates.length, 1);
    const t = l.templates[0];
    assert.equal(t.id, 't0001');
    assert.equal(t.prompt, '把正文翻译成日文。');
    assert.equal(t.updatedAt, '2026-11-01');
    assert.equal((await (await admin(e, 'pending')).json()).pending.length, 0);
    const again = await admin(e, 'approve', { ref });
    assert.equal(again.status, 409);
});

test('update submission → same id, version 2, createdAt kept', async () => {
    const e = env();
    const { ref } = await (await submit(e)).json();
    await admin(e, 'approve', { ref });
    const { ref: r2 } = await (await submit(e, { ...good, name: '中译日 v2', prompt: '新版正文。', updateOf: 't0001' })).json();
    const a = await (await admin(e, 'approve', { ref: r2 })).json();
    assert.deepEqual(a, { ok: true, id: 't0001', version: 2 });
    const t = (await lib(e)).templates;
    assert.equal(t.length, 1);
    assert.equal(t[0].name, '中译日 v2');
    assert.equal(t[0].prompt, '新版正文。');
    assert.equal(t[0].createdAt, '2026-11-01');
});

test('reject → gone from queue, never public', async () => {
    const e = env();
    const { ref } = await (await submit(e)).json();
    assert.equal((await admin(e, 'reject', { ref })).status, 200);
    assert.equal((await (await admin(e, 'pending')).json()).pending.length, 0);
    assert.deepEqual((await lib(e)).templates, []);
    assert.equal((await admin(e, 'approve', { ref })).status, 409, 'a rejected ref cannot be approved later');
});

test('delete → removed from library; ids are never reused', async () => {
    const e = env();
    const { ref } = await (await submit(e)).json();
    await admin(e, 'approve', { ref });
    assert.equal((await admin(e, 'delete', { id: 't0001' })).status, 200);
    assert.deepEqual((await lib(e)).templates, []);
    assert.equal((await admin(e, 'delete', { id: 't0001' })).status, 404);
    const { ref: r2 } = await (await submit(e, { ...good, name: '另一个' })).json();
    assert.equal((await (await admin(e, 'approve', { ref: r2 })).json()).id, 't0002');
});

test('update whose target was deleted meanwhile → 409, submission stays pending', async () => {
    const e = env();
    const { ref } = await (await submit(e)).json();
    await admin(e, 'approve', { ref });
    const { ref: r2 } = await (await submit(e, { ...good, updateOf: 't0001' })).json();
    await admin(e, 'delete', { id: 't0001' });
    const r = await admin(e, 'approve', { ref: r2 });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'update_target_gone');
    assert.equal((await (await admin(e, 'pending')).json()).pending.length, 1);
});

test('admin: malformed refs / ids → 400', async () => {
    const e = env();
    assert.equal((await admin(e, 'approve', { ref: '../lib' })).status, 400);
    assert.equal((await admin(e, 'reject', { ref: 123 })).status, 400);
    assert.equal((await admin(e, 'delete', { id: 'lib' })).status, 400);
});

test('newest-updated first in the library', async () => {
    const e = env();
    const { ref: a } = await (await submit(e, { ...good, name: 'A' })).json();
    await admin(e, 'approve', { ref: a });
    clock += 2 * 86400000;
    const { ref: b } = await (await submit(e, { ...good, name: 'B' })).json();
    await admin(e, 'approve', { ref: b });
    assert.deepEqual((await lib(e)).templates.map((t) => t.name), ['B', 'A']);
});

/* ---------- 兜底 ---------- */

test('a broken KV still yields a Response with CORS on public routes', async () => {
    const broken = { get: async () => { throw new Error('kv down'); }, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) };
    const r = await call(env({ HUB: broken }), '/library.json');
    assert.equal(r.status, 502);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

/* ---------- 管理页 ---------- */

test('admin page: served with a strict CSP, no external resources, no innerHTML', async () => {
    const r = await call(env(), '/admin');
    assert.equal(r.status, 200);
    const csp = r.headers.get('Content-Security-Policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(ADMIN_HTML, /<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    assert.doesNotMatch(ADMIN_HTML, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    assert.match(ADMIN_HTML, /sessionStorage/);
    assert.doesNotMatch(ADMIN_HTML, /localStorage/, 'the password must not outlive the tab');
});
