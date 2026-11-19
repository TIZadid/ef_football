# Game On

Splits our regular football group into two balanced teams based on player ratings and positions.
Plain static site in `public/` (no build step), hosted on Vercel.

## Develop

```sh
nvm use          # Node 22
npm run dev      # http://localhost:8787
npm test         # balancing algorithm tests
```

Pushing to `main` deploys automatically once the repo is connected in Vercel.
The balancing algorithm lives in `public/js/balance.js`.
