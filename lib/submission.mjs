// 故事神谕 · 模板广场：提交规则的唯一真源（Worker / Action 都 import 它；扩展里有一份逐条等价的副本，
// 由 test/fixtures/submission-cases.json 双边钉住）。改这里 = 同步改 index.js 的 fixHub* 副本 + 夹具。

export const MARKER = '<!-- SO-TEMPLATE v1 -->';
export const LIMITS = Object.freeze({ name: 40, prompt: 8000, description: 200, author: 30, model: 60, client: 20, tagsMin: 1, tagsMax: 3 });
export const DEFAULT_TAGS = ['去AI味', '润色文风', '翻译', '格式整理', '视角人称', '扩写补写', '精简', '其他'];
export const FIELD_MESSAGES = {
    'name.required': '模板名字不能为空',
    'name.too_long': '模板名字最多 40 个字',
    'prompt.required': '模板正文不能为空',
    'prompt.too_long': '模板正文最多 8000 个字',
    'description.too_long': '说明最多 200 个字',
    'author.too_long': '作者名最多 30 个字',
    'model.too_long': '测试模型最多 60 个字',
    'tags.too_few_tags': '至少选 1 个标签',
    'tags.too_many_tags': '最多选 3 个标签',
    'tags.bad_tag': '标签不在列表里，刷新广场后再选',
    'updateOf.bad_update': '要更新的模板在广场里找不到了',
    'updateOf.unknown_update': '要更新的模板在广场里找不到了',
    '_fallback': '内容格式不对',
};

const ID_RE = /^t\d{4,}$/;

export function clean(s) {
    let t = String(s);
    t = typeof t.toWellFormed === 'function'
        ? t.toWellFormed()
        : t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
    t = t.replace(/\r\n?/g, '\n');
    return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

const cpLen = (s) => [...s].length;
const cpCut = (s, n) => [...s].slice(0, n).join('');
// 单行字段（name/author/description/model）：clean 之后把「含换行/制表符」的空白段整段折成一个空格，再 trim；
// prompt 是唯一的多行字段，不折叠。
const collapseLines = (s) => s.replace(/\s*[\n\t]\s*/g, ' ');

export function validateSubmission(input, tags, knownIds) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ field: '_', code: 'bad_type' }] };
    const errors = [];
    const value = {};
    const str = (field, required, max, singleLine) => {
        const raw = input[field];
        if (raw === undefined || raw === null) {
            if (required) errors.push({ field, code: 'required' });
            value[field] = '';
            return;
        }
        if (typeof raw !== 'string') { errors.push({ field, code: 'bad_type' }); value[field] = ''; return; }
        let t = clean(raw);
        if (singleLine) t = collapseLines(t);
        t = t.trim();
        if (required && !t) errors.push({ field, code: 'required' });
        else if (cpLen(t) > max) errors.push({ field, code: 'too_long' });
        value[field] = t;
    };
    str('name', true, LIMITS.name, true);
    str('prompt', true, LIMITS.prompt, false);
    str('description', false, LIMITS.description, true);
    str('author', false, LIMITS.author, true);
    const rawTags = (input.tags === undefined || input.tags === null) ? [] : input.tags;
    if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string')) {
        errors.push({ field: 'tags', code: 'bad_type' });
        value.tags = [];
    } else {
        const uniq = [...new Set(rawTags.map((t) => clean(t).trim()).filter(Boolean))];
        value.tags = uniq;
        const allowed = Array.isArray(tags) ? tags : [];
        if (uniq.length < LIMITS.tagsMin) errors.push({ field: 'tags', code: 'too_few_tags' });
        else if (uniq.length > LIMITS.tagsMax) errors.push({ field: 'tags', code: 'too_many_tags' });
        else if (uniq.some((t) => !allowed.includes(t))) errors.push({ field: 'tags', code: 'bad_tag' });
    }
    str('model', false, LIMITS.model, true);
    const u = input.updateOf;
    if (u === undefined || u === null || u === '') value.updateOf = null;
    else if (typeof u !== 'string') { errors.push({ field: 'updateOf', code: 'bad_type' }); value.updateOf = null; }
    else if (!ID_RE.test(u)) { errors.push({ field: 'updateOf', code: 'bad_update' }); value.updateOf = null; }
    else if (Array.isArray(knownIds) && !knownIds.includes(u)) { errors.push({ field: 'updateOf', code: 'unknown_update' }); value.updateOf = u; }
    else value.updateOf = u;
    value.client = typeof input.client === 'string' ? cpCut(clean(input.client).trim(), LIMITS.client) : '';
    return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function fieldMessage(field, code) {
    return FIELD_MESSAGES[`${field}.${code}`] || FIELD_MESSAGES._fallback;
}

export function buildShareBlock(value) {
    const body = JSON.stringify(value, null, 2).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
    return `${MARKER}\n\`\`\`json\n${body}\n\`\`\``;
}

export function parseShareBlock(text) {
    const s = String(text == null ? '' : text);
    const at = s.indexOf(MARKER);
    if (at < 0) return null;
    const m = s.slice(at + MARKER.length).match(/^\s*```json\n([\s\S]*?)\n```/);
    if (!m) return null;
    let v;
    try { v = JSON.parse(m[1]); } catch (e) { return null; }
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}
