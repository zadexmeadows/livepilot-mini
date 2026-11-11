# Streamlabs Rounds Mini

A small Railway deployable control page based on the attached LivePilot project. It connects multiple YouTube accounts, listens to one livestream for Streamlabs round announcements, and sends a chosen chat command from each selected account. It has no metrics dashboard or points calculations in the round listener.

## Deploy to Railway

1. Put the contents of this folder at the root of a GitHub repository and create a Railway project from that repository. Railway detects the root `Dockerfile` automatically.
2. Add a Railway **Volume** mounted at `/app/data`. This holds the SQLite database and isolated browser profiles. Keep this service to one replica so two instances do not use the same browser profiles or SQLite file.
3. Add these service variables in Railway:

   - `BASIC_AUTH_USER`: your sign-in name for the mini app
   - `BASIC_AUTH_PASSWORD`: a long, unique password for the mini app
   - `VNC_PASSWORD`: a separate 8-character ASCII password for the remote browser console (x11vnc uses only the first eight characters)
   - `PLAYWRIGHT_CHROMIUM_SANDBOX`: leave unset on Railway; set to `true` only on hosts that allow Chromium's Linux namespace sandbox

4. Generate a Railway domain. Open it, sign in with the Basic Auth credentials, and use **Connect account** to open the remote browser console.
5. In the remote browser, sign into YouTube manually. Click **Finish sign-in** beside that account; the app closes its remote Chrome window and checks the saved session. Repeat for each account.
6. Enter the livestream URL, select the accounts and command messages, then save and start Streamlabs Mode.

The first selected account watches Streamlabs announcements. Other selected accounts join each round in sequence, using the configured delay. If no announcement arrives, the timer fallback starts a round. Keep the Railway volume attached when redeploying; deleting it removes the saved sessions and database.

The listener stops when the server restarts. After a redeploy, open the control page and press **Start** again.

## Local run

Requires Node.js 22.13+ and npm 10+.

```sh
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

Copy `.env.example` to `.env` first. Local manual sign-in requires an installed Chrome browser and a desktop session. The Railway Docker image provides the remote browser console.

## Railway variables and storage

In Railway service settings, set the healthcheck path to `/healthz`. Railway's `PORT` is handled by a small same-origin proxy, which protects the app and the remote browser console with Basic Auth. The health check path is the only unauthenticated path.

The app uses SQLite at `/app/data/app.db` and stores each YouTube login under `/app/data/browser-profiles/`. Railway mounts volumes as root; the entrypoint assigns the data directory to the app user before launching Next.js and Chromium as a non-root user. Treat the volume as sensitive because it contains signed-in browser profiles. To reset all accounts, stop the service and clear the volume.

Railway's standard container blocks the Linux namespace operations required by Chromium's sandbox. The browser therefore starts without that sandbox by default while still running as the unprivileged `livepilot` user. Use the remote browser only for trusted destinations such as YouTube. Set `PLAYWRIGHT_CHROMIUM_SANDBOX=true` only on a host configured to permit Chromium's namespace sandbox.

## What it does

- Add and reconnect multiple isolated YouTube browser accounts.
- Watch one YouTube livestream for Streamlabs round announcements.
- Send one configured message per account in each round.
- Pause or stop the listener and view its current state and recent Streamlabs activity.

It does not automate Google sign-in or attempt to bypass YouTube restrictions. Sign in yourself in the remote browser console.
