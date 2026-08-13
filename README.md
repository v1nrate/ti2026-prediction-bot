# TI 2026 Prediction Bot — Cloudflare Workers

Telegram-only tracker for the user's The International 2026 predictions.

## Why this version

- Cloudflare Workers Free
- no website
- no local PC/VPN required
- Telegram webhook
- Cron Trigger every 5 minutes
- SQLite-backed Durable Object remembers collected games and previous prediction state

## Required Cloudflare secret

After the first deploy, add:

    BOT_TOKEN = your NEW BotFather token

`ADMIN_USER_ID` is optional. If it is not set, the first Telegram account that sends `/start`
becomes the owner of the bot.

## Initial setup

After adding `BOT_TOKEN`, open:

    https://<your-worker>.workers.dev/setup

The Worker will register its Telegram webhook.

Then send `/start` to the Telegram bot.

## Routes

- `/` - simple health text
- `/setup` - register Telegram webhook
- `/health` - current bot/tournament state
- `/check` - force TI sync and send prediction changes
- `/telegram/webhook` - Telegram webhook

## Deployment

Cloudflare Git Builds:

Build command:

    npm install

Deploy command:

    npx wrangler deploy

Do not put BOT_TOKEN into GitHub.
