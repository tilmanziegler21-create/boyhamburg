# Deploy to Render (Background Worker)

## Prerequisites
- Fork this repository to your GitHub account
- Create an account on Render.com

## Deploy Steps
1. In Render, click "New +" → "Blueprint" and select your fork
2. Render will auto-detect `render.yaml` and propose a Worker service
3. In the Worker settings:
   - Build Command: `npm ci && npm run build`
   - Start Command: `node dist/index.js`
   - Attach Disk: already configured in `render.yaml` as `/data` (for SQLite)
4. Set Environment Variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `DATA_BACKEND` = `sheets` or `mock`
   - `TIMEZONE` = `Europe/Berlin`
   - `CITY_CODES` = e.g. `FFM`
   - `DB_PATH` = `/data/app.db`
   - If using Google Sheets backend:
     - `GOOGLE_SHEETS_SPREADSHEET_ID` = your spreadsheet id
     - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = service account email
     - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` = full private key (include line breaks as-is)

## Notes
- This Worker runs the Telegram bot (polling) + cron jobs + optional HTTP health at `GET /health` if you expose a Web service in addition.
- Disk `/data` persists your SQLite database across deployments.
- All cron schedules run in `Europe/Berlin`.

