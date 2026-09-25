import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCases } from './_fixtures.mjs';
import {
    MARKER, LIMITS, DEFAULT_TAGS, FIELD_MESSAGES, clean, validateSubmission, fieldMessage,
    buildShareBlock, parseShareBlock,
} from '../lib/submission.mjs';

const cases = loadCases();

for (const c of cases.validate) {
    test(`validate · ${c.id}`, () => {
        const r = validateSubmission(c.input, cases.tags, c.knownIds);
        assert.equal(r.ok, c.expect.ok);
        if (c.expect.ok && c.expect.value) assert.deepEqual(r.value, c.expect.value);
        if (!c.expect.ok) assert.deepEqual(r.errors, c.expect.errors);
    });
}

for (const c of cases.block) {
    test(`block round-trip · ${c.id}`, () => {
        const text = buildShareBlock(c.value);
        assert.ok(text.startsWith(MARKER + '\n```json\n'));
        assert.ok(text.endsWith('\n```'));
        assert.equal((text.match(/`/g) || []).length, 6, 'only the two fences may contain backticks');
        assert.equal(text.indexOf(MARKER, 1), -1, 'marker appears exactly once');
        assert.deepEqual(parseShareBlock(text), c.value);
        assert.deepEqual(parseShareBlock(cases.noise.prefix + text + cases.noise.suffix), c.value);
    });
}

for (const c of cases.parseBad) {
    test(`parse rejects · ${c.id}`, () => assert.equal(parseShareBlock(c.text), null));
}

test('DEFAULT_TAGS equals tags.json', () => {
    const tags = JSON.parse(readFileSync(new URL('../tags.json', import.meta.url), 'utf8'));
    assert.deepEqual(DEFAULT_TAGS, tags);
});

test('FIELD_MESSAGES equals fixture fieldMessages', () => {
    assert.deepEqual(FIELD_MESSAGES, cases.fieldMessages);
});

test('fieldMessage falls back for bad_type and unknown keys', () => {
    assert.equal(fieldMessage('name', 'required'), '模板名字不能为空');
    assert.equal(fieldMessage('tags', 'bad_type'), '内容格式不对');
    assert.equal(fieldMessage('zzz', 'yyy'), '内容格式不对');
});

test('clean keeps tab/newline, strips controls, fixes surrogates, normalises CR', () => {
    assert.equal(clean('a\tb\nc\r\nd\re\u0000\u009f\ud800'), 'a\tb\nc\nd\ne�');
});

test('LIMITS frozen values', () => {
    assert.deepEqual({ ...LIMITS }, { name: 40, prompt: 8000, description: 200, author: 30, model: 60, client: 20, tagsMin: 1, tagsMax: 3 });
    assert.ok(Object.isFrozen(LIMITS));
});
