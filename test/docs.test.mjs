import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('README states public sharing + review', () => {
    const r = read('README.md');
    assert.match(r, /分享后模板公开，任何人都能下载使用/);
    assert.match(r, /审核/);
    assert.match(r, /SO-TEMPLATE v1/);
});
test('issue template labels submissions, and never contains the literal marker (Review: it must not pre-seed a bare marker that beats the pasted one)', () => {
    const t = read('.github/ISSUE_TEMPLATE/share.md');
    assert.match(t, /labels: submission/);
    assert.ok(!t.includes('<!-- SO-TEMPLATE v1 -->'), 'template body must not contain the marker string, not even in backticks');
    assert.match(t, /SO-TEMPLATE/);
});
test('SETUP covers token scope, KV, secrets, deploy, labels', () => {
    const s = read('docs/SETUP.md');
    for (const needle of ['Issues', 'Read and write', 'wrangler kv namespace create', 'wrangler secret put GH_TOKEN', 'wrangler secret put SALT', 'wrangler deploy', 'approved', 'submission', 'invalid']) {
        assert.ok(s.includes(needle), needle);
    }
});
