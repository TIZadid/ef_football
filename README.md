# Game On

Splits our regular football group into two balanced teams based on player ratings and positions.
Static site in `public/` (no build step) plus one serverless function in `api/`, hosted on Vercel.

## Develop

```sh
nvm use          # Node 22
npm run dev      # http://localhost:8787 (no syncing locally: everything stays in the browser)
npm test         # algorithm and sync tests
```

## Rooms and syncing

Each group has a **room**: a unique 4–8 digit code plus a PIN. The first screen asks
for both, or lets you create a new room (you get a random code, or pick your own).
Everything for a room (squad, guests, rules, matchday, this week's teams) syncs
across devices through `api/state.js`; `api/room.js` creates and opens rooms.

Data is stored in Upstash Redis (free tier). To turn it on:

1. Vercel dashboard → this project → **Storage** → **Create Database** → **Upstash for Redis** (free plan).
2. Connect it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. Redeploy. The dot in the top bar shows **Saved** once it's working.

Data from before rooms existed lives in room **9999**. It has no PIN until someone
enters it: the first PIN used becomes its PIN. Ten wrong PINs lock a room for 15 minutes.

Ratings run from 1 to 5. The balancing algorithm lives in `public/js/balance.js`.
