// 模板广场 Worker（2026-11-01 起：全在 Cloudflare，不再碰 GitHub）。
// 公开：GET /library.json（已发布的模板库，与 1.86.0 dist/library.json 同形状）· POST /submit（投稿进待审队列）。
// 管理：GET /admin（自带页面）· /admin/api/*（Authorization: Bearer <ADMIN_TOKEN>）。
// 存储只用一个 KV（绑定 HUB）：sub:<ref> 待审 · lib 已发布库（唯一真相）· seq 下一个编号 · rl:/af: 计数（24h 过期）。
// IP 只以 sha256(SALT|日期|IP) 出现，从不落原文。设计稿：SillyTavern/docs/superpowers/specs/2026-11-01-template-hub-cloudflare-design.md
import { validateSubmission, DEFAULT_TAGS } from '../lib/submission.mjs';
import { ADMIN_HTML } from './admin-page.js';

const RATE_LIMIT = 5;            // 每 IP 每天投稿数
const ADMIN_FAIL_LIMIT = 20;     // 每 IP 每天管理密码错误次数
const QUEUE_CAP = 300;           // 待审队列上限（防刷爆 KV 免费写额度）
const BODY_CAP = 65536;
const DAY = 86400;
const ID_RE = /^t\d{4,}$/;
const REF_RE = /^s[0-9a-z]{6,40}$/;

const PUBLIC_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const NO_STORE = { 'Cache-Control': 'no-store' };

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const pub = (status, obj, extra = {}) => json(status, obj, { ...PUBLIC_CORS, ...NO_STORE, ...extra });
const adm = (status, obj) => json(status, obj, NO_STORE);

async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 等长比较两份摘要（不直接比明文：长度不同也不提前返回）。
async function sameSecret(a, b) {
    const [x, y] = await Promise.all([sha256Hex('so-hub|' + String(a)), sha256Hex('so-hub|' + String(b))]);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

const ipKey = async (env, prefix, now, request) =>
    prefix + await sha256Hex(`${env.SALT || ''}|${now.toISOString().slice(0, 10)}|${request.headers.get('CF-Connecting-IP') || 'unknown'}`);

const emptyLib = (now) => ({ schema: 1, generatedAt: now.toISOString(), tags: DEFAULT_TAGS, templates: [] });

async function readLib(env, now) {
    const raw = await env.HUB.get('lib');
    if (!raw) return emptyLib(now);
    try {
        const lib = JSON.parse(raw);
        if (lib && Array.isArray(lib.templates)) return lib;
    } catch (e) { /* fall through */ }
    throw new Error('library corrupt');
}

const sortTemplates = (list) => list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));

async function writeLib(env, lib, now) {
    lib.generatedAt = now.toISOString();
    lib.tags = DEFAULT_TAGS;
    sortTemplates(lib.templates);
    await env.HUB.put('lib', JSON.stringify(lib));
}

async function nextId(env, lib) {
    const fromLib = Math.max(0, ...lib.templates.map((t) => Number(String(t.id).slice(1)) || 0));
    const stored = Number(await env.HUB.get('seq')) || 0;
    const n = Math.max(fromLib, stored) + 1;
    await env.HUB.put('seq', String(n));
    return 't' + String(n).padStart(4, '0');
}

function newRef(now) {
    const rnd = crypto.getRandomValues(new Uint8Array(6));
    return 's' + now.getTime().toString(36) + [...rnd].map((b) => b.toString(36).padStart(2, '0')).join('');
}

async function listPending(env) {
    const out = [];
    let cursor;
    do {
        const page = await env.HUB.list({ prefix: 'sub:', cursor });
        for (const k of page.keys) {
            const raw = await env.HUB.get(k.name);
            if (!raw) continue;   // KV 列表最终一致：刚删的键还可能列出来
            try { out.push(JSON.parse(raw)); } catch (e) { /* skip */ }
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

async function countPending(env) {
    let n = 0;
    let cursor;
    do {
        const page = await env.HUB.list({ prefix: 'sub:', cursor });
        n += page.keys.length;
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && n < QUEUE_CAP);
    return n;
}

// ---------------- 公开路由 ----------------

async function getLibrary(env, now) {
    const lib = await readLib(env, now);
    return new Response(JSON.stringify(lib), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PUBLIC_CORS, 'Cache-Control': 'public, max-age=60' } });
}

async function postSubmit(request, env, now) {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > BODY_CAP) return pub(413, { ok: false, error: 'too_large' });
    let input;
    try { input = JSON.parse(raw); } catch (e) { return pub(400, { ok: false, error: 'bad_json' }); }
    const lib = await readLib(env, now);
    const v = validateSubmission(input, DEFAULT_TAGS, lib.templates.map((t) => t.id));
    if (!v.ok) return pub(400, { ok: false, error: 'invalid', errors: v.errors });
    const key = await ipKey(env, 'rl:', now, request);
    const count = Number(await env.HUB.get(key)) || 0;
    if (count >= RATE_LIMIT) return pub(429, { ok: false, error: 'rate' });
    if (await countPending(env) >= QUEUE_CAP) return pub(503, { ok: false, error: 'queue_full' });
    await env.HUB.put(key, String(count + 1), { expirationTtl: DAY });
    const ref = newRef(now);
    await env.HUB.put('sub:' + ref, JSON.stringify({ ref, at: now.toISOString(), value: v.value }));
    return pub(200, { ok: true, ref });
}

// ---------------- 管理路由 ----------------

async function adminAuth(request, env, now) {
    if (!env.ADMIN_TOKEN || String(env.ADMIN_TOKEN).length < 16) return adm(503, { ok: false, error: 'admin_not_configured' });
    const failKey = await ipKey(env, 'af:', now, request);
    const fails = Number(await env.HUB.get(failKey)) || 0;
    if (fails >= ADMIN_FAIL_LIMIT) return adm(429, { ok: false, error: 'locked' });
    const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
    if (m && await sameSecret(m[1], env.ADMIN_TOKEN)) return null;
    await env.HUB.put(failKey, String(fails + 1), { expirationTtl: DAY });
    return adm(401, { ok: false, error: 'unauthorized' });
}

async function readBody(request) {
    const raw = await request.text();
    if (raw.length > 4096) return null;
    try { const o = JSON.parse(raw); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch (e) { return null; }
}

async function adminApprove(request, env, now) {
    const body = await readBody(request);
    const ref = body && body.ref;
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return adm(400, { ok: false, error: 'bad_ref' });
    // 双击 / 重发防重复发布：KV 删除要一会儿才在各地生效，故另记一枚「已处理」标记（7 天过期）。
    const done = await env.HUB.get('done:' + ref);
    if (done) return adm(409, { ok: false, error: 'already_done', id: done });
    const raw = await env.HUB.get('sub:' + ref);
    if (!raw) return adm(404, { ok: false, error: 'not_found' });
    const sub = JSON.parse(raw);
    const s = sub.value;
    const lib = await readLib(env, now);
    const today = now.toISOString().slice(0, 10);
    let id, version;
    if (s.updateOf) {
        const old = lib.templates.find((t) => t.id === s.updateOf);
        if (!old) return adm(409, { ok: false, error: 'update_target_gone' });
        id = old.id;
        version = (Number.isInteger(old.version) ? old.version : 1) + 1;
        Object.assign(old, { name: s.name, author: s.author, description: s.description, tags: s.tags, model: s.model, version, updatedAt: today, prompt: s.prompt });
    } else {
        id = await nextId(env, lib);
        version = 1;
        lib.templates.push({ id, name: s.name, author: s.author, description: s.description, tags: s.tags, model: s.model, version, createdAt: today, updatedAt: today, prompt: s.prompt });
    }
    await env.HUB.put('done:' + ref, id, { expirationTtl: 7 * DAY });
    await writeLib(env, lib, now);
    await env.HUB.delete('sub:' + ref);
    return adm(200, { ok: true, id, version });
}

async function adminReject(request, env) {
    const body = await readBody(request);
    const ref = body && body.ref;
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return adm(400, { ok: false, error: 'bad_ref' });
    if (await env.HUB.get('done:' + ref)) return adm(409, { ok: false, error: 'already_done' });
    await env.HUB.put('done:' + ref, 'rejected', { expirationTtl: 7 * DAY });
    await env.HUB.delete('sub:' + ref);
    return adm(200, { ok: true });
}

async function adminDelete(request, env, now) {
    const body = await readBody(request);
    const id = body && body.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return adm(400, { ok: false, error: 'bad_id' });
    const lib = await readLib(env, now);
    const before = lib.templates.length;
    lib.templates = lib.templates.filter((t) => t.id !== id);
    if (lib.templates.length === before) return adm(404, { ok: false, error: 'not_found' });
    await writeLib(env, lib, now);
    return adm(200, { ok: true });
}

// ---------------- 入口 ----------------

// 对外只从这里出：任何未预料的异常都兜成 502，保证有 Response（公开路由带 CORS 头，前端才显示得出「出错了」）。
export async function handle(request, env, deps = {}) {
    let url;
    try { url = new URL(request.url); } catch (e) { return pub(400, { ok: false, error: 'bad_url' }); }
    const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
    try {
        return await route(request, env, deps.now ? deps.now() : new Date(), url);
    } catch (e) {
        return isAdmin ? adm(502, { ok: false, error: 'upstream' }) : pub(502, { ok: false, error: 'upstream' });
    }
}

async function route(request, env, now, url) {
    const p = url.pathname;
    const m = request.method;
    if (p === '/library.json' || p === '/submit') {
        if (m === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_CORS });
        if (p === '/library.json' && (m === 'GET' || m === 'HEAD')) return getLibrary(env, now);
        if (p === '/submit' && m === 'POST') return postSubmit(request, env, now);
        return pub(405, { ok: false, error: 'method' });
    }
    if (p === '/admin' && m === 'GET') {
        return new Response(ADMIN_HTML, { status: 200, headers: {
            'Content-Type': 'text/html; charset=utf-8', ...NO_STORE,
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
        } });
    }
    if (p.startsWith('/admin/api/')) {
        const denied = await adminAuth(request, env, now);
        if (denied) return denied;
        const op = p.slice('/admin/api/'.length);
        if (op === 'pending' && m === 'GET') return adm(200, { ok: true, pending: await listPending(env) });
        if (op === 'published' && m === 'GET') return adm(200, { ok: true, templates: (await readLib(env, now)).templates });
        if (op === 'approve' && m === 'POST') return adminApprove(request, env, now);
        if (op === 'reject' && m === 'POST') return adminReject(request, env);
        if (op === 'delete' && m === 'POST') return adminDelete(request, env, now);
        return adm(404, { ok: false, error: 'not_found' });
    }
    return pub(404, { ok: false, error: 'not_found' });
}

export default { fetch: (request, env) => handle(request, env) };
