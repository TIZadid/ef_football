# Game On

Splits our regular football group into two balanced teams based on player ratings and positions.
Static site in `public/` (no build step) plus one serverless function in `api/`, hosted on Vercel.

## Develop

```sh
nvm use          # Node 22
npm run dev      # http://localhost:8787 (no syncing locally: everything stays in the browser)
npm test         # algorithm and sync tests
```

## Syncing across devices

The squad, recent guests, matchday settings and house rules sync through `api/state.js`,
which stores one JSON document in Upstash Redis (free tier). To turn it on:

1. Vercel dashboard → this project → **Storage** → **Create Database** → **Upstash for Redis** (free plan).
2. Connect it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. Redeploy. The app bar shows **Synced** once it's working.

Without storage the app still works, saving on each device only.

The balancing algorithm lives in `public/js/balance.js`.
