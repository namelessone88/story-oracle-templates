import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, issueBody, _resetTagCache } from '../worker/index.js';
import { parseShareBlock } from '../lib/submission.mjs';

const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, _m: m }; };
const env = (over = {}) => ({ REPO: 'o/r', GH_TOKEN: 'secret', SALT: 's', RL: kv(), ...over });
const good = { name: '中译日', prompt: '把正文翻译成日文。', tags: ['翻译'], client: '1.86.0' };
const req = (body, { method = 'POST', path = '/submit', ip = '1.2.3.4' } = {}) =>
    new Request('https://w.test' + path, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });

function fakeFetch({ tags = ['翻译', '其他'], issueStatus = 201 } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/tags.json')) return new Response(JSON.stringify(tags), { status: 200 });
        if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ number: 57 }), { status: issueStatus });
        return new Response('no', { status: 404 });
    };
    fn.calls = calls;
    return fn;
}

test.beforeEach(() => _resetTagCache());

test('OPTIONS preflight → 204 with CORS', async () => {
    const r = await handle(req(null, { method: 'OPTIONS' }), env(), { fetch: fakeFetch() });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('unknown route → 404 not_found', async () => {
    const r = await handle(req(good, { path: '/x' }), env(), { fetch: fakeFetch() });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { ok: false, error: 'not_found' });
});

test('happy path files an issue with label and block', async () => {
    const f = fakeFetch();
    const r = await handle(req(good), env(), { fetch: f });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, issue: 57 });
    const gh = f.calls.find((c) => c.url === 'https://api.github.com/repos/o/r/issues');
    assert.equal(gh.init.method, 'POST');
    assert.equal(gh.init.headers.Authorization, 'Bearer secret');
    const payload = JSON.parse(gh.init.body);
    assert.equal(payload.title, '[模板] 中译日');
    assert.deepEqual(payload.labels, ['submission']);
    assert.equal(parseShareBlock(payload.body).name, '中译日');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('update title', async () => {
    const f = fakeFetch();
    await handle(req({ ...good, updateOf: 't0042' }), env(), { fetch: f });
    const payload = JSON.parse(f.calls.find((c) => c.url.startsWith('https://api.github.com/')).init.body);
    assert.equal(payload.title, '[更新 t0042] 中译日');
});

test('bad JSON / too large / invalid', async () => {
    let r = await handle(req('{nope'), env(), { fetch: fakeFetch() });
    assert.deepEqual([r.status, await r.json()], [400, { ok: false, error: 'bad_json' }]);
    r = await handle(req('x'.repeat(65537)), env(), { fetch: fakeFetch() });
    assert.deepEqual([r.status, await r.json()], [413, { ok: false, error: 'too_large' }]);
    r = await handle(req({ ...good, tags: ['精简'] }), env(), { fetch: fakeFetch() });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, error: 'invalid', errors: [{ field: 'tags', code: 'bad_tag' }] });
});

test('body cap raised to 64KB: 8000×4-byte-emoji prompt + 200-emoji description is accepted (Review item 5)', async () => {
    const payload = { name: '大表情', prompt: '😀'.repeat(8000), description: '😀'.repeat(200), tags: ['翻译'] };
    const r = await handle(req(payload), env(), { fetch: fakeFetch() });
    assert.equal(r.status, 200);
});

test('tags fall back to DEFAULT_TAGS when tags.json unreachable', async () => {
    const f = async (url) => (String(url).endsWith('/tags.json') ? new Response('x', { status: 500 }) : new Response(JSON.stringify({ number: 1 }), { status: 201 }));
    const r = await handle(req({ ...good, tags: ['精简'] }), env(), { fetch: f });
    assert.equal(r.status, 200);
});

test('rate limit: 6th submission from same IP same day → 429, other IP fine, raw IP never stored', async () => {
    const e = env();
    const f = fakeFetch();
    const now = () => new Date('2026-09-30T10:00:00Z');
    for (let i = 0; i < 5; i += 1) assert.equal((await handle(req(good), e, { fetch: f, now })).status, 200);
    const r6 = await handle(req(good), e, { fetch: f, now });
    assert.deepEqual([r6.status, await r6.json()], [429, { ok: false, error: 'rate' }]);
    assert.equal((await handle(req(good, { ip: '5.6.7.8' }), e, { fetch: f, now })).status, 200);
    for (const k of e.RL._m.keys()) assert.ok(!k.includes('1.2.3.4'));
});

test('GitHub failure → 502 upstream', async () => {
    const r = await handle(req(good), env(), { fetch: fakeFetch({ issueStatus: 500 }) });
    assert.deepEqual([r.status, await r.json()], [502, { ok: false, error: 'upstream' }]);
});

test('GitHub returns 2xx with a non-JSON body → caught as 502 upstream, still carries CORS (Review item 4)', async () => {
    const f = async (url) => (String(url).endsWith('/tags.json') ? new Response(JSON.stringify(['翻译', '其他']), { status: 200 }) : new Response('not json', { status: 201 }));
    const r = await handle(req(good), env(), { fetch: f });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: 'upstream' });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('KV throwing → caught as 502 upstream, still carries CORS (Review item 4)', async () => {
    const e = env({ RL: { get: async () => { throw new Error('kv down'); }, put: async () => {} } });
    const r = await handle(req(good), e, { fetch: fakeFetch() });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: 'upstream' });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('issueBody: summary neutralises @mentions, block first, readable prompt fenced longer than any run', () => {
    const b = issueBody({ name: '@everyone hi', prompt: 'a ```` b', author: '@x', description: 'd\ne', tags: ['翻译'], model: '', updateOf: null, client: '' });
    assert.ok(!/(^|\s)@everyone/.test(b.split('<!-- SO-TEMPLATE v1 -->')[0]));
    assert.ok(b.indexOf('<!-- SO-TEMPLATE v1 -->') < b.indexOf('<details>'));
    assert.ok(b.includes('`````text\na ```` b\n`````'));
});

test('issueBody: marker text inside name/author/description does not break parsing of the real block (Review item 3)', () => {
    const v = { name: '<!-- SO-TEMPLATE v1 -->', prompt: 'p', author: '<!-- SO-TEMPLATE v1 -->', description: '<!-- SO-TEMPLATE v1 -->', tags: ['翻译'], model: '', updateOf: null, client: '' };
    const b = issueBody(v);
    assert.deepEqual(parseShareBlock(b), v);
});
