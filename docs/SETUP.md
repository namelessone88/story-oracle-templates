# One-time setup (Prince)

## 1. GitHub repo
1. Create the public repo `namelessone88/story-oracle-templates`, push this folder to `main`.
2. Labels → create `submission`, `approved`, `invalid`.
3. Settings → Actions → General → Workflow permissions: "Read and write permissions".

## 2. Token for the Worker (fine-grained)
GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
- Repository access: **Only select repositories** → `story-oracle-templates`
- Permissions → Repository → **Issues: Read and write** (nothing else)
- Expiration: 1 year (calendar a reminder to rotate).

## 3. Cloudflare Worker
```bash
cd worker
npx wrangler login
npx wrangler kv namespace create RL          # copy the printed id into wrangler.toml (replace SET_IN_TASK_10)
npx wrangler secret put GH_TOKEN             # paste the token from step 2
npx wrangler secret put SALT                 # paste any long random string
npx wrangler deploy                          # prints https://so-template-hub.<you>.workers.dev
```

## 4. Extension
Put the printed Worker URL into `FIX_HUB_WORKER_URL` in Story Oracle's `index.js`.

## 5. Routine
New Issue with label `submission` → read it → add label `approved` to publish (the Action comments
「已发布为 tXXXX」 and closes it). To reject, just close it. A failed publish gets `invalid` + a comment.
Discord turns messages over ~2000 characters into a `message.txt` attachment; open it and paste its
content into the new Issue.
