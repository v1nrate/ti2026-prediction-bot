# TI 2026 Prediction Bot — Render version

Telegram-only bot. No website and no Django.

## What it does

- tracks the user's 16 TI 2026 team predictions;
- pulls professional match data from OpenDota;
- reconstructs completed BO3 series;
- shows current prediction status;
- sends notifications when prediction status changes;
- works through Telegram webhook, so the local PC and VPN are not required.

## Render deployment

Create a free Render Web Service from this repository.

Build command:

    pip install -r requirements.txt

Start command:

    python main.py

Environment variables:

    BOT_TOKEN=<new BotFather token>
    ADMIN_USER_ID=<your Telegram numeric ID>
    RENDER_EXTERNAL_URL=https://<your-render-service>.onrender.com
    CHECK_INTERVAL_SECONDS=120
    OPENDOTA_LEAGUE_ID=19719

`OPENDOTA_API_KEY` can stay empty initially.

After deployment, open:

    https://<your-render-service>.onrender.com/health

Expected JSON contains:

    "ok": true
    "league_id": 19719
    "games": <number greater than 0>

## Keeping the free Render service awake

Render free Web Services can sleep. The `/health` endpoint performs a throttled tournament
check, so it is designed to be called by a free external uptime/cron service every 5-10 minutes.

Do not put BOT_TOKEN into GitHub.
