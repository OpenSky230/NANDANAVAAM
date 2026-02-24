# Netlify deploy (with Functions)

This project uses a Netlify Function (`netlify/functions/vr.mjs`) to talk to Keycloak + VR APIs securely (client secret stays server-side).

## Why you can’t drag-and-drop `dist` anymore

Drag-and-drop deploys only the static files. Netlify Functions need a Functions deploy (Git build or Netlify CLI deploy).

## One-time: create a new Netlify site

1. Netlify Dashboard → **Add new site**
2. You can connect the GitHub repo for code history, but the pano files are intentionally not committed (they are huge).
3. Set **Environment variables** in Netlify:
   - `KEYCLOAK_SERVER_URL=https://keycloak.dev.opensky.co.in`
   - `KEYCLOAK_REALM=opensky-stage`
   - `KEYCLOAK_CLIENT_ID=vr-server-client`
   - `KEYCLOAK_CLIENT_SECRET=...`
   - `VR_API_BASE_URL=...`

## Deploy from your computer (recommended for this repo)

From the project folder:

1. Build:
   - `npm run build`
2. Deploy site + functions:
   - `npx --yes netlify-cli login`
   - `npx --yes netlify-cli init`
   - `npx --yes netlify-cli deploy --prod --dir=dist --functions=netlify/functions`

## Smoke test

After deploy, these should exist on your site domain:

- `POST /.netlify/functions/vr/session/start`
- `POST /.netlify/functions/vr/session/complete`
- `GET /.netlify/functions/vr/sessions`

