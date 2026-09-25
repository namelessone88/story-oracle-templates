// 模板广场投稿 Worker：只有 POST /submit。校验 → 每 IP 每天 5 次 → 用 GH_TOKEN（仅本仓 Issues 读写）开 Issue。
// IP 只以 sha256(SALT|日期|IP) 进 KV、24h 过期，从不落原文。
import { validateSubmission, buildShareBlock, DEFAULT_TAGS } from '../lib/submission.mjs';

const RATE_LIMIT = 5;
const BODY_CAP = 65536;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
let tagCache = null;
export const _resetTagCache = () => { tagCache = null; };

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

async function loadTags(env, fetchFn, nowMs) {
    if (tagCache && nowMs - tagCache.at < 600000) return tagCache.tags;
    try {
        const r = await fetchFn(`https://cdn.jsdelivr.net/gh/${env.REPO}@main/tags.json`);
        if (r.ok) {
            const t = await r.json();
            if (Array.isArray(t) && t.every((x) => typeof x === 'string')) { tagCache = { at: nowMs, tags: t }; return t; }
        }
    } catch (e) { /* fall through */ }
    return DEFAULT_TAGS;
}

async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 人类可读摘要行只允许纯文字：@ 提及会 ping 人；`<` 是标记 <!-- SO-TEMPLATE v1 --> 的唯一特征字符——
// 名字 / 作者 / 说明 / 模型这些单行字段如果原样等于或包含这串文字，indexOf(MARKER) 会先命中这里、
// 而不是后面真正的区块，导致合法投稿解析失败；反引号一并转义避免摘要行破坏围栏观感。
const noMention = (s) => String(s).replace(/@/g, '＠').replace(/</g, '＜').replace(/`/g, '｀').replace(/\n/g, ' ');

export function issueBody(v) {
    const longest = Math.max(0, ...(v.prompt.match(/`+/g) || []).map((m) => m.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return [
        `**名字**：${noMention(v.name)}`,
        `**作者**：${noMention(v.author || '匿名')}`,
        `**标签**：${noMention(v.tags.join(' / '))}`,
        `**测试模型**：${noMention(v.model || '—')}`,
        `**说明**：${noMention(v.description || '—')}`,
        `**类型**：${v.updateOf ? `更新 ${v.updateOf}` : '新模板'}`,
        '',
        buildShareBlock(v),
        '',
        '<details><summary>正文</summary>',
        '',
        `${fence}text\n${v.prompt}\n${fence}`,
        '</details>',
    ].join('\n');
}

// 对外只从这里出——任何未预料的异常（GitHub 回一个解析不了的 body、KV 绑定本身抛错……）都兜成
// 502 upstream，而不是让 Response 都没造出来就往外抛：裸抛出去在 Workers 里连 CORS 头都不带，
// 浏览器只会报一个网络错误，前端连「提交没成功」这种文案都显示不出来。
export async function handle(request, env, deps = {}) {
    try {
        return await handleInner(request, env, deps);
    } catch (e) {
        return json(502, { ok: false, error: 'upstream' });
    }
}

async function handleInner(request, env, deps) {
    const fetchFn = deps.fetch || fetch;
    const now = deps.now ? deps.now() : new Date();
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname !== '/submit' || request.method !== 'POST') return json(404, { ok: false, error: 'not_found' });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > BODY_CAP) return json(413, { ok: false, error: 'too_large' });
    let input;
    try { input = JSON.parse(raw); } catch (e) { return json(400, { ok: false, error: 'bad_json' }); }
    const tags = await loadTags(env, fetchFn, now.getTime());
    const v = validateSubmission(input, tags, null);
    if (!v.ok) return json(400, { ok: false, error: 'invalid', errors: v.errors });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = 'rl:' + await sha256Hex(`${env.SALT || ''}|${now.toISOString().slice(0, 10)}|${ip}`);
    const count = Number(await env.RL.get(key)) || 0;
    if (count >= RATE_LIMIT) return json(429, { ok: false, error: 'rate' });
    await env.RL.put(key, String(count + 1), { expirationTtl: 86400 });
    const title = (v.value.updateOf ? `[更新 ${v.value.updateOf}] ` : '[模板] ') + v.value.name;
    let res;
    try {
        res = await fetchFn(`https://api.github.com/repos/${env.REPO}/issues`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.GH_TOKEN}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'so-template-hub',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ title, body: issueBody(v.value), labels: ['submission'] }),
        });
    } catch (e) { return json(502, { ok: false, error: 'upstream' }); }
    if (!res.ok) return json(502, { ok: false, error: 'upstream' });
    const issue = await res.json();
    return json(200, { ok: true, issue: issue.number });
}

export default { fetch: (request, env) => handle(request, env) };
