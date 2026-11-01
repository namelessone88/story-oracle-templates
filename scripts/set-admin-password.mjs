// 设置 / 更换模板广场审核后台的管理员密码（Worker 密钥 ADMIN_TOKEN）。
// Set (or rotate) the admin password = Worker secret ADMIN_TOKEN on script so-templates.
//
// 用法 / Usage（在 story-oracle-templates 目录里 / from the story-oracle-templates folder）:
//   node scripts/set-admin-password.mjs            真的设置：生成新密码、写进 Cloudflare、在终端里显示一次
//   node scripts/set-admin-password.mjs --dry-run  只演练：不调 Cloudflare、显示的是假密码
//
// 凭据读自 .local/cloudflare.json（{ apiToken, accountId }，已 gitignore）。令牌永远不会被打印。
// 每次运行都会生成一个【新】密码并覆盖旧的——旧密码随即失效。
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'so-templates';
const SECRET_NAME = 'ADMIN_TOKEN';
const ADMIN_URL = 'https://templates.fabschoolcard.bid/admin';

const dryRun = process.argv.includes('--dry-run');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credPath = path.join(repoRoot, '.local', 'cloudflare.json');

function fail(msg) {
    console.error('\n✗ ' + msg + '\n');
    process.exit(1);
}

let cfg;
try {
    cfg = JSON.parse(readFileSync(credPath, 'utf8'));
} catch (e) {
    fail(`读不到凭据文件 / cannot read credentials: ${credPath}\n  (${e.code || e.message})`);
}
if (!cfg || typeof cfg.apiToken !== 'string' || !cfg.apiToken || typeof cfg.accountId !== 'string' || !cfg.accountId) {
    fail('凭据文件缺少 apiToken 或 accountId / credentials file is missing apiToken or accountId');
}

// 24 随机字节 → base64url = 32 个字符 / 24 random bytes → 32 base64url chars.
const password = dryRun ? 'DRY-RUN-PLACEHOLDER-not-a-real-password' : randomBytes(24).toString('base64url');

const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/workers/scripts/${SCRIPT_NAME}/secrets`;

if (dryRun) {
    console.log('\n[演练 / dry run] 不会调用 Cloudflare / no API call is made.');
    console.log(`  将会请求 / would send: PUT ${url}`);
    console.log(`  内容 / body: {"name":"${SECRET_NAME}","text":"<新密码 / new password>","type":"secret_text"}`);
} else {
    let res, data;
    try {
        res = await fetch(url, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: SECRET_NAME, text: password, type: 'secret_text' }),
        });
    } catch (e) {
        fail(`连不上 Cloudflare / network error: ${e.cause?.code || e.message}`);
    }
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.success !== true) {
        const errs = (data && Array.isArray(data.errors) && data.errors.length)
            ? data.errors.map((x) => `[${x.code}] ${x.message}`).join('; ')
            : '(没有错误详情 / no error details)';
        fail(`Cloudflare 拒绝了 / Cloudflare refused (HTTP ${res.status}): ${errs}\n  密码没有被设置，旧密码（如有）仍然有效。/ Nothing was changed.`);
    }
}

const bar = '='.repeat(64);
console.log('\n' + bar);
console.log(dryRun ? '  [演练] 这是假密码 / [dry run] placeholder only:' : '  ✓ 管理员密码已设置 / Admin password set:');
console.log('');
console.log('      ' + password);
console.log('');
console.log('  请马上把它存进密码管理器——它只显示这一次，之后无法再查看。');
console.log('  Save it now (e.g. in a password manager) — it is shown only once');
console.log('  and cannot be read back later.');
console.log('');
console.log(`  审核后台 / Admin page: ${ADMIN_URL}`);
console.log('  忘了密码就再运行一次本脚本，会生成新密码、旧的作废。');
console.log('  Lost it? Run this script again: a new password replaces the old one.');
console.log(bar + '\n');
