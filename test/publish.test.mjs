import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applySubmission, buildLibrary, idFor, applyApprovedIssues, writeLibraryIfChanged } from '../scripts/publish.mjs';
import { buildShareBlock } from '../lib/submission.mjs';

function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'sotpl-'));
    mkdirSync(path.join(dir, 'templates'));
    cpSync(new URL('../tags.json', import.meta.url), path.join(dir, 'tags.json'));
    return dir;
}
const sub = (over = {}) => ({ name: '中译日', prompt: '把正文翻译成日文。\n保留人名。', author: '海盐柠檬', description: '翻译用', tags: ['翻译'], model: 'DS', updateOf: null, client: '1.86.0', ...over });
const body = (v) => `**名字**：${v.name}\n\n${buildShareBlock(v)}\n\n<details><summary>正文</summary>\n\n\`\`\`\`text\n${v.prompt}\n\`\`\`\`\n</details>`;

test('idFor pads to 4', () => {
    assert.equal(idFor(42), 't0042');
    assert.equal(idFor(12345), 't12345');
});

test('new submission writes folder', () => {
    const dir = repo();
    const r = applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    assert.deepEqual(r, { ok: true, id: 't0042', version: 1, isUpdate: false });
    assert.equal(readFileSync(path.join(dir, 'templates/t0042/template.txt'), 'utf8'), '把正文翻译成日文。\n保留人名。');
    const meta = JSON.parse(readFileSync(path.join(dir, 'templates/t0042/meta.json'), 'utf8'));
    assert.deepEqual(meta, { name: '中译日', author: '海盐柠檬', description: '翻译用', tags: ['翻译'], model: 'DS', version: 1, createdAt: '2026-09-30', updatedAt: '2026-09-30', sourceIssues: [42] });
});

test('update bumps version, keeps createdAt, appends issue', () => {
    const dir = repo();
    applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    const r = applySubmission({ repoRoot: dir, issueNumber: 57, body: body(sub({ prompt: '新版', updateOf: 't0042' })), today: '2026-10-05' });
    assert.deepEqual(r, { ok: true, id: 't0042', version: 2, isUpdate: true });
    const meta = JSON.parse(readFileSync(path.join(dir, 'templates/t0042/meta.json'), 'utf8'));
    assert.equal(meta.createdAt, '2026-09-30');
    assert.equal(meta.updatedAt, '2026-10-05');
    assert.deepEqual(meta.sourceIssues, [42, 57]);
    assert.equal(readFileSync(path.join(dir, 'templates/t0042/template.txt'), 'utf8'), '新版');
    assert.equal(existsSync(path.join(dir, 'templates/t0057')), false);
});

test('marker inside the readable prompt section does not confuse the parser', () => {
    const dir = repo();
    const v = sub({ prompt: '<!-- SO-TEMPLATE v1 -->\n```json\n{"name":"evil"}\n```' });
    const r = applySubmission({ repoRoot: dir, issueNumber: 43, body: body(v), today: '2026-09-30' });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'templates/t0043/meta.json'), 'utf8')).name, '中译日');
});

test('Discord paste route: issue template (no bare marker) + copied share text still parses (Review item 1)', () => {
    const dir = repo();
    const template = readFileSync(new URL('../.github/ISSUE_TEMPLATE/share.md', import.meta.url), 'utf8');
    const shareText = '把这段发到神谕 Discord 的模板分享频道\n' + buildShareBlock(sub());
    const r = applySubmission({ repoRoot: dir, issueNumber: 42, body: template + '\n' + shareText, today: '2026-09-30' });
    assert.equal(r.ok, true);
});

test('invalid submissions return Chinese reasons and write nothing', () => {
    const dir = repo();
    assert.deepEqual(applySubmission({ repoRoot: dir, issueNumber: 44, body: 'no block', today: '2026-09-30' }), { ok: false, reason: '没找到 SO-TEMPLATE 区块' });
    const r = applySubmission({ repoRoot: dir, issueNumber: 45, body: body(sub({ name: '', tags: [] })), today: '2026-09-30' });
    assert.deepEqual(r, { ok: false, reason: '模板名字不能为空；至少选 1 个标签' });
    const u = applySubmission({ repoRoot: dir, issueNumber: 46, body: body(sub({ updateOf: 't0999' })), today: '2026-09-30' });
    assert.deepEqual(u, { ok: false, reason: '要更新的模板在广场里找不到了' });
    assert.equal(existsSync(path.join(dir, 'templates/t0044')), false);
});

test('existing id for a new submission is refused', () => {
    const dir = repo();
    applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    assert.deepEqual(applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' }), { ok: false, reason: '编号 t0042 已存在' });
});

test('applyApprovedIssues: processes every issue in the injected list, one result per issue, in order (Review item 2 — no gh call, no event-only processing)', () => {
    const dir = repo();
    const results = applyApprovedIssues({
        repoRoot: dir,
        issues: [
            { number: 42, body: body(sub()) },
            { number: 50, body: body(sub({ name: 'B' })) },
        ],
        today: '2026-09-30',
    });
    assert.deepEqual(results, [
        { issue: 42, ok: true, id: 't0042', version: 1, isUpdate: false },
        { issue: 50, ok: true, id: 't0050', version: 1, isUpdate: false },
    ]);
});

test('applyApprovedIssues: an already-published id (still labelled approved, e.g. a race with another run) is reported invalid — fine per idempotency note', () => {
    const dir = repo();
    applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    const results = applyApprovedIssues({ repoRoot: dir, issues: [{ number: 42, body: body(sub()) }], today: '2026-09-30' });
    assert.deepEqual(results, [{ issue: 42, ok: false, reason: '编号 t0042 已存在' }]);
});

test('update path against a broken meta.json returns ok:false with 处理失败 prefix instead of throwing (Review item 6)', () => {
    const dir = repo();
    mkdirSync(path.join(dir, 'templates/t0042'), { recursive: true });
    writeFileSync(path.join(dir, 'templates/t0042/meta.json'), '{broken');
    const r = applySubmission({ repoRoot: dir, issueNumber: 99, body: body(sub({ updateOf: 't0042' })), today: '2026-09-30' });
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith('处理失败：'), r.reason);
});

test('build: no rewrite when only generatedAt would differ; content change does rewrite (Review item 7)', () => {
    const dir = repo();
    applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    const distFile = path.join(dir, 'dist', 'library.json');
    const first = writeLibraryIfChanged(dir, '2026-10-01T00:00:00.000Z');
    assert.equal(first.changed, true);
    const before = readFileSync(distFile, 'utf8');
    const second = writeLibraryIfChanged(dir, '2026-10-02T00:00:00.000Z');
    assert.equal(second.changed, false);
    assert.equal(readFileSync(distFile, 'utf8'), before, 'file must stay byte-identical (old generatedAt kept) when nothing else changed');
    applySubmission({ repoRoot: dir, issueNumber: 50, body: body(sub({ name: 'B' })), today: '2026-10-02' });
    const third = writeLibraryIfChanged(dir, '2026-10-03T00:00:00.000Z');
    assert.equal(third.changed, true);
    assert.notEqual(readFileSync(distFile, 'utf8'), before);
});

test('buildLibrary: sorted by updatedAt desc then id, skips broken folders, deterministic', () => {
    const dir = repo();
    applySubmission({ repoRoot: dir, issueNumber: 42, body: body(sub()), today: '2026-09-30' });
    applySubmission({ repoRoot: dir, issueNumber: 50, body: body(sub({ name: 'B' })), today: '2026-10-02' });
    mkdirSync(path.join(dir, 'templates/t0060'));
    writeFileSync(path.join(dir, 'templates/t0060/meta.json'), '{broken');
    const lib = buildLibrary(dir, '2026-10-02T00:00:00.000Z');
    assert.equal(lib.schema, 1);
    assert.equal(lib.generatedAt, '2026-10-02T00:00:00.000Z');
    assert.deepEqual(lib.tags, JSON.parse(readFileSync(path.join(dir, 'tags.json'), 'utf8')));
    assert.deepEqual(lib.templates.map((t) => t.id), ['t0050', 't0042']);
    assert.deepEqual(Object.keys(lib.templates[0]), ['id', 'name', 'author', 'description', 'tags', 'model', 'version', 'updatedAt', 'prompt']);
    assert.deepEqual(buildLibrary(dir, '2026-10-02T00:00:00.000Z'), lib);
});
