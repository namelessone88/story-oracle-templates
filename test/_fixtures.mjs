import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function expand(x) {
    if (Array.isArray(x)) return x.map(expand);
    if (x && typeof x === 'object') {
        const keys = Object.keys(x);
        if (keys.length === 1 && keys[0] === '$repeat') return String(x.$repeat[0]).repeat(x.$repeat[1]);
        return Object.fromEntries(keys.map((k) => [k, expand(x[k])]));
    }
    return x;
}

export function loadCases() {
    return expand(JSON.parse(readFileSync(path.join(here, 'fixtures', 'submission-cases.json'), 'utf8')));
}
