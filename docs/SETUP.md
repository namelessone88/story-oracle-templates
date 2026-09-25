# Setup (Prince) — done 2026-09-25

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
