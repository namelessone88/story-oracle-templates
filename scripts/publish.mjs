// 模板广场发布脚本：apply（把一条已批准的 Issue 落成 templates/<id>/）、build（重建 dist/library.json）、
// report（在 Issue 上留言 / 关单 / 打 invalid）。只由 .github/workflows/publish.yml 调用。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShareBlock, validateSubmission, fieldMessage } from '../lib/submission.mjs';

const ID_RE = /^t\d{4,}$/;
export const idFor = (n) => 't' + String(n).padStart(4, '0');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
const listIds = (root) => existsSync(path.join(root, 'templates'))
    ? readdirSync(path.join(root, 'templates'), { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name).sort()
    : [];

export function applySubmission({ repoRoot, issueNumber, body, today }) {
    const input = parseShareBlock(body);
    if (!input) return { ok: false, reason: '没找到 SO-TEMPLATE 区块' };
    const tags = readJson(path.join(repoRoot, 'tags.json'));
    const known = listIds(repoRoot);
    const v = validateSubmission(input, tags, known);
    if (!v.ok) return { ok: false, reason: [...new Set(v.errors.map((e) => fieldMessage(e.field, e.code)))].join('；') };
    const s = v.value;
    const isUpdate = !!s.updateOf;
    const id = isUpdate ? s.updateOf : idFor(issueNumber);
    const dir = path.join(repoRoot, 'templates', id);
    let meta;
    if (isUpdate) {
        let old;
        try {
            old = readJson(path.join(dir, 'meta.json'));
        } catch (e) {
            return { ok: false, reason: '处理失败：' + e.message };
        }
        meta = {
            name: s.name, author: s.author, description: s.description, tags: s.tags, model: s.model,
            version: (Number.isInteger(old.version) ? old.version : 1) + 1,
            createdAt: old.createdAt || today, updatedAt: today,
            sourceIssues: [...new Set([...(Array.isArray(old.sourceIssues) ? old.sourceIssues : []), issueNumber])],
        };
    } else {
        if (existsSync(dir)) return { ok: false, reason: `编号 ${id} 已存在` };
        mkdirSync(dir, { recursive: true });
        meta = { name: s.name, author: s.author, description: s.description, tags: s.tags, model: s.model, version: 1, createdAt: today, updatedAt: today, sourceIssues: [issueNumber] };
    }
    writeFileSync(path.join(dir, 'template.txt'), s.prompt, 'utf8');
    writeJson(path.join(dir, 'meta.json'), meta);
    return { ok: true, id, version: meta.version, isUpdate };
}

// 并发批准安全：一次处理【当前所有】仍标着 approved 的开放 Issue（而不只是触发本次运行的那一条）——
// 两个几乎同时的批准各自触发一次运行时，无论谁先跑，都会把当时能看到的全部 approved 一次性处理掉；
// 另一条已经被处理过（因而已关闭、不再是 open）的运行会看到空列表，直接空跑，不会重复发布或漏发。
export function applyApprovedIssues({ repoRoot, issues, today }) {
    return (Array.isArray(issues) ? issues : []).map((iss) => ({
        issue: iss.number,
        ...applySubmission({ repoRoot, issueNumber: iss.number, body: iss.body || '', today }),
    }));
}

// build 只在内容（generatedAt 以外的部分）真的变了才落盘——避免「什么都没变」也产生一次发布提交。
export function writeLibraryIfChanged(repoRoot, nowIso) {
    const lib = buildLibrary(repoRoot, nowIso);
    const distPath = path.join(repoRoot, 'dist', 'library.json');
    let prev = null;
    try { prev = readJson(distPath); } catch (e) { prev = null; }
    const withoutGeneratedAt = (l) => { const { generatedAt, ...rest } = l; return rest; };
    if (prev && JSON.stringify(withoutGeneratedAt(prev)) === JSON.stringify(withoutGeneratedAt(lib))) {
        return { changed: false, lib: prev };
    }
    mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
    writeJson(distPath, lib);
    return { changed: true, lib };
}

export function buildLibrary(repoRoot, nowIso) {
    const tags = readJson(path.join(repoRoot, 'tags.json'));
    const templates = [];
    for (const id of listIds(repoRoot)) {
        try {
            const meta = readJson(path.join(repoRoot, 'templates', id, 'meta.json'));
            const prompt = readFileSync(path.join(repoRoot, 'templates', id, 'template.txt'), 'utf8');
            templates.push({
                id, name: meta.name, author: meta.author || '', description: meta.description || '',
                tags: Array.isArray(meta.tags) ? meta.tags : [], model: meta.model || '',
                version: meta.version, updatedAt: meta.updatedAt || '', prompt,
            });
        } catch (e) {
            console.warn(`[publish] skip ${id}: ${e.message}`);
        }
    }
    templates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
    return { schema: 1, generatedAt: nowIso, tags, templates };
}

// ---------------- CLI（仅 Action 用）----------------
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const resultPath = path.join(root, '.publish-result.json');

function cliApply() {
    const today = new Date().toISOString().slice(0, 10);
    const raw = execFileSync('gh', ['issue', 'list', '--label', 'approved', '--state', 'open', '--json', 'number,body', '--limit', '100'], { encoding: 'utf8' });
    const issues = JSON.parse(raw);
    const results = applyApprovedIssues({ repoRoot: root, issues, today });
    writeJson(resultPath, results);
    if (process.env.GITHUB_OUTPUT) {
        const ids = results.filter((r) => r.ok).map((r) => r.id);
        appendFileSync(process.env.GITHUB_OUTPUT, `id=${ids.join(',')}\n`);
    }
}
function cliBuild() {
    writeLibraryIfChanged(root, new Date().toISOString());
}
function cliReport() {
    if (!existsSync(resultPath)) return;
    const results = readJson(resultPath);
    const gh = (...args) => execFileSync('gh', args, { stdio: 'inherit' });
    for (const r of (Array.isArray(results) ? results : [results])) {
        const num = String(r.issue);
        if (r.ok) {
            gh('issue', 'comment', num, '--body', `已发布为 ${r.id}${r.isUpdate ? `（第 ${r.version} 版）` : ''}`);
            gh('issue', 'close', num);
        } else {
            gh('issue', 'comment', num, '--body', `没能发布：${r.reason}`);
            gh('issue', 'edit', num, '--add-label', 'invalid');
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === 'apply') cliApply();
    else if (cmd === 'build') cliBuild();
    else if (cmd === 'report') cliReport();
    else { console.error('usage: publish.mjs apply|build|report'); process.exit(2); }
}
