# Cloudflare-only setup (2026-11-01) — CURRENT

Design: `SillyTavern/docs/superpowers/specs/2026-11-01-template-hub-cloudflare-design.md`. No GitHub involved any more.

Live values (deployed 2026-11-01):
- Worker: **`so-templates`**, served only at **`https://templates.fabschoolcard.bid`** (custom domain; `workers_dev = false`).
  Routes: `GET /library.json` (public, CORS `*`, `max-age=60`) · `POST /submit` (public) · `GET /admin` (review page) ·
  `/admin/api/*` (`Authorization: Bearer <ADMIN_TOKEN>`).
- Cloudflare account id: `04413aee9214047683c9f64835d03c46`; zone `fabschoolcard.bid`.
- KV namespace: title `HUB`, id **`4b1adbc4401749c1847fd8f8ed7b3280`**, binding `HUB` (in `worker/wrangler.toml`).
- Secrets (values live only in Cloudflare): `SALT` (set 2026-11-01) · `ADMIN_TOKEN` (the admin password — Prince sets it
  himself with `scripts/set-admin-password.mjs`, see below). Until `ADMIN_TOKEN` is set, `/admin/api/*` answers
  503 `admin_not_configured`.
- API token for wrangler / the scripts: `.local/cloudflare.json` = `{ "apiToken", "accountId" }` (gitignored, never commit).
  Permissions: Workers Scripts Edit, Workers KV Storage Edit, Workers Routes Edit, DNS Edit, Zone Read (zone limited to
  `fabschoolcard.bid`).
- Not ours, don't touch: R2 `fabula-assets` / `fabula-reports`, Worker `fabula-report`, DNS `art.` / `report.`, KV namespace `RL`.
  The old Worker `so-template-hub` (2026-09 GitHub version) is left as is.

## A. Wrangler on this PC (Windows ARM64)
`npx wrangler` crashes on ARM64 (no native workerd). Working recipe = install into a scratch folder and force the
x64 workerd build (runs emulated):
```powershell
mkdir C:\tools\wrangler; cd C:\tools\wrangler
npm init -y
npm i wrangler@4.156.0
npm i --no-save --force @cloudflare/workerd-windows-64@1.20261023.1
```
Run it as `node C:\tools\wrangler\node_modules\wrangler\bin\wrangler.js <command>` with the working directory =
`story-oracle-templates\worker`. A libuv `UV_HANDLE_CLOSING` assertion printed at exit is harmless.
Credentials go in through env vars, not `wrangler login`: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from
`.local/cloudflare.json` (a tiny node wrapper that reads the JSON and `spawnSync`s wrangler with `env` set keeps the
token out of the shell history). (On 2026-11-01 the install lived in a Claude scratchpad folder that can disappear —
reinstall with the recipe above when needed.)

## B. Redeploy after changing `worker/`
1. `node --test` in `story-oracle-templates` → all green.
2. From `worker\`: `wrangler deploy` (use `wrangler deploy --dry-run` first if unsure). Secrets and KV data survive a redeploy.
3. Check: `https://templates.fabschoolcard.bid/library.json` → 200 JSON; `/admin` → 200.

First-time setup that was done once (2026-11-01, for the record): `wrangler kv namespace create HUB` → id into
`wrangler.toml` → `wrangler deploy` (Cloudflare created the custom-domain DNS record + certificate itself) →
`SALT` = 32 random bytes hex via `wrangler secret bulk <temp json>` (file deleted afterwards).

## C. Set / change the admin password
In your own PowerShell window (the password must only ever appear there):
```powershell
cd C:\Games\SillyTavern\SillyTavern\story-oracle-templates
node scripts/set-admin-password.mjs
```
It generates a random 32-character password, stores it as the Worker secret `ADMIN_TOKEN` through the Cloudflare API,
and prints it **once** — save it in a password manager. Running it again makes a new password and the old one stops
working (that is also the "forgot password" fix). `--dry-run` shows what it would do without calling Cloudflare.

## D. Routine: review submissions
Open `https://templates.fabschoolcard.bid/admin`, enter the password (kept only for this browser tab). Pending
submissions are listed with their full text → **发布** (publish; an update of an existing template keeps its id and bumps
the version) or **拒绝** (reject). Published templates are listed below with **删除** (delete). Changes reach users
within about a minute (library cache `max-age=60`). More than 20 wrong passwords per IP per day → locked out (429)
until the next day.

---

# (Historical) GitHub-based setup — done 2026-09-25, retired 2026-11-01

Everything below describes the old GitHub Issues + Actions + jsDelivr pipeline (Worker `so-template-hub`). Kept for
reference only; it is no longer how the hub works.

Live values:
- Repo: `namelessone88/story-oracle-templates` (public). Labels `submission` / `approved` / `invalid`.
  Actions → Workflow permissions = "Read and write".
- Worker: `https://so-template-hub.namelessone88.workers.dev` (Cloudflare account subdomain `namelessone88`).
  KV binding `RL` (id in `worker/wrangler.toml`). Secrets `GH_TOKEN`, `SALT` (only in Cloudflare).
- Extension: `FIX_HUB_WORKER_URL` in Story Oracle's `index.js` points at the Worker.
- End-to-end test passed 2026-09-25 (Issue #1 → `t0001` → visible in 🌐 广场 → deleted).

## 1. GitHub repo
1. Create the public repo `namelessone88/story-oracle-templates`, push this folder to `main`.
2. Labels → create `submission`, `approved`, `invalid`.
3. Settings → Actions → General → Workflow permissions: "Read and write permissions".
4. A `gh` login that pushes `.github/workflows/` needs the `workflow` scope (`gh auth refresh -s workflow`).

## 2. Token for the Worker (fine-grained)
GitHub → Settings → Developer settings → Fine-grained tokens → Generate
(https://github.com/settings/personal-access-tokens/new):
- Repository access: **Only select repositories** → `story-oracle-templates`
- Permissions → Repository → **Issues: Read and write** (nothing else)
- Expiration: 1 year — **rotate before it expires** (generate a new one, then step 3's `secret put GH_TOKEN` again).
  If it expires, 提交分享 fails with 「分享服务暂时出错」; 复制分享文本 still works.

## 3. Cloudflare Worker
```bash
cd worker
npx wrangler login
npx wrangler kv namespace create RL          # copy the printed id into wrangler.toml
npx wrangler deploy                          # prints https://so-template-hub.<subdomain>.workers.dev
npx wrangler secret put GH_TOKEN             # paste the token from step 2
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SALT
```
Gotchas met on 2026-09-25:
- A new account needs a workers.dev subdomain before the first deploy. The onboarding URL wrangler prints
  may 404; change/set it in the dashboard: Compute → Workers & Pages → "Subdomain" box → Change.
  The subdomain is public (it is in the extension), so don't use one derived from an email address.
- `wrangler secret put GH_TOKEN` must run in a **real terminal** (PowerShell window). Run through a
  non-interactive shell it shows no prompt and may store an empty value.
- A freshly registered subdomain takes a minute or two before HTTPS answers.

## 4. Extension
Put the printed Worker URL into `FIX_HUB_WORKER_URL` in Story Oracle's `index.js`.

## 5. Routine
New Issue with label `submission` → read it → add label `approved` to publish (the Action comments
「已发布为 tXXXX」 and closes it). To reject, just close it. A failed publish gets `invalid` + a comment.
Discord turns messages over ~2000 characters into a `message.txt` attachment; open it and paste its
content into the new Issue.

To remove a published template: delete its `templates/<id>/` folder on GitHub; the push rebuilds
`dist/library.json`.

Mirrors: the `testingcf.jsdelivr.net` mirror is a separate cache that the Action's purge does not reach —
it can lag behind for hours. The extension asks all three mirrors and uses the newest library, so this only
delays users who can reach nothing but that mirror.
