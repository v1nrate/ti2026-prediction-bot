from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from aiohttp import web
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.types import KeyboardButton, Message, ReplyKeyboardMarkup, Update

from app.config import get_settings
from app.formatters import changes_text, predictions_text, recent_games_text, status_text
from app.opendota import OpenDotaClient, OpenDotaError
from app.tournament import snapshot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ti2026-render")

settings = get_settings()
router = Router()
dp = Dispatcher()
dp.include_router(router)

bot = Bot(
    token=settings.bot_token,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)

opendota = OpenDotaClient(settings.opendota_api_key, settings.opendota_league_id)

MENU = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📊 Статус"), KeyboardButton(text="🎯 Мои прогнозы")],
        [KeyboardButton(text="🎮 Последние матчи"), KeyboardButton(text="🔄 Проверить сейчас")],
    ],
    resize_keyboard=True,
)

# Render free filesystem is ephemeral, so current tournament state is rebuilt from OpenDota.
STATE: dict[str, Any] = {
    "games": [],
    "league_id": None,
    "snapshot": None,
    "last_sync": 0.0,
    "last_error": None,
}
SYNC_LOCK = asyncio.Lock()


def allowed(message: Message) -> bool:
    return settings.admin_user_id is None or message.from_user.id == settings.admin_user_id


async def sync_data(force: bool = False, notify: bool = False) -> tuple[int, int]:
    async with SYNC_LOCK:
        now = time.monotonic()
        # Prevent duplicate OpenDota requests when /health is pinged often.
        if (
            not force
            and STATE["games"]
            and now - float(STATE["last_sync"]) < settings.check_interval_seconds
        ):
            return int(STATE["league_id"]), 0

        league_id, games = await opendota.fetch_ti_games()
        old_ids = {g.match_id for g in STATE["games"]}
        new_ids = {g.match_id for g in games} - old_ids

        old_snapshot = STATE["snapshot"]
        new_snapshot = snapshot(games)

        STATE["league_id"] = league_id
        STATE["games"] = games
        STATE["snapshot"] = new_snapshot
        STATE["last_sync"] = now
        STATE["last_error"] = None

        if notify and old_snapshot is not None and settings.admin_user_id:
            text = changes_text(old_snapshot, new_snapshot)
            if text:
                await bot.send_message(settings.admin_user_id, text)
                log.info("Prediction notification sent")

        log.info(
            "Synced TI 2026: league=%s games=%s new=%s",
            league_id,
            len(games),
            len(new_ids),
        )
        return league_id, len(new_ids)


async def safe_sync(force: bool = False, notify: bool = False) -> tuple[int | None, int]:
    try:
        return await sync_data(force=force, notify=notify)
    except Exception as exc:
        STATE["last_error"] = str(exc)
        log.exception("TI sync failed")
        return STATE["league_id"], 0


async def send_long(message: Message, text: str) -> None:
    chunks = []
    while len(text) > 3900:
        cut = text.rfind("\n", 0, 3900)
        if cut < 1000:
            cut = 3900
        chunks.append(text[:cut])
        text = text[cut:].lstrip()
    chunks.append(text)

    for chunk in chunks:
        await message.answer(chunk, reply_markup=MENU)


@router.message(CommandStart())
async def start_handler(message: Message):
    if not allowed(message):
        return

    await safe_sync()

    await message.answer(
        "🏆 <b>TI 2026 Prediction Bot</b>\n\n"
        "Слежу за твоими прогнозами на The International 2026.\n"
        "Нажимай кнопки ниже — сайт не нужен.\n\n"
        f"Твой Telegram ID: <code>{message.from_user.id}</code>",
        reply_markup=MENU,
    )


@router.message(Command("predictions"))
@router.message(F.text == "🎯 Мои прогнозы")
async def predictions_handler(message: Message):
    if not allowed(message):
        return
    await send_long(message, predictions_text())


@router.message(Command("status"))
@router.message(F.text == "📊 Статус")
async def status_handler(message: Message):
    if not allowed(message):
        return

    await safe_sync()
    if not STATE["games"]:
        error = STATE["last_error"] or "данные турнира пока не получены"
        await message.answer(f"⚠️ Не удалось получить матчи TI 2026:\n<code>{error}</code>")
        return

    await send_long(message, status_text(STATE["games"]))


@router.message(Command("matches"))
@router.message(F.text == "🎮 Последние матчи")
async def matches_handler(message: Message):
    if not allowed(message):
        return

    await safe_sync()
    if not STATE["games"]:
        await message.answer("⚠️ Пока нет загруженных матчей TI 2026.")
        return

    await send_long(message, recent_games_text(STATE["games"]))


@router.message(Command("check"))
@router.message(F.text == "🔄 Проверить сейчас")
async def check_handler(message: Message):
    if not allowed(message):
        return

    await message.answer("🔄 Проверяю TI 2026…")
    league_id, added = await safe_sync(force=True, notify=True)

    if not STATE["games"]:
        await message.answer(
            "❌ Не удалось загрузить матчи.\n"
            f"<code>{STATE['last_error'] or 'неизвестная ошибка'}</code>"
        )
        return

    await message.answer(
        f"✅ Готово.\n"
        f"League ID: <code>{league_id}</code>\n"
        f"Карт в турнире: <b>{len(STATE['games'])}</b>\n"
        f"Новых карт: <b>{added}</b>"
    )
    await send_long(message, status_text(STATE["games"]))


async def webhook_handler(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        update = Update.model_validate(payload, context={"bot": bot})
        await dp.feed_update(bot, update)
        return web.Response(text="OK")
    except Exception:
        log.exception("Webhook processing failed")
        return web.Response(text="ERROR", status=500)


async def health_handler(request: web.Request) -> web.Response:
    # An external free monitor can ping this route every 5-10 minutes.
    # It both keeps Render awake and performs a throttled TI check.
    await safe_sync(notify=True)

    return web.json_response(
        {
            "ok": True,
            "league_id": STATE["league_id"],
            "games": len(STATE["games"]),
            "last_error": STATE["last_error"],
        }
    )


async def root_handler(request: web.Request) -> web.Response:
    return web.Response(
        text="TI 2026 Prediction Bot is running.\nUse /health for status.",
        content_type="text/plain",
    )


async def on_startup(app: web.Application) -> None:
    render_url = settings.render_external_url.rstrip("/")
    webhook_url = f"{render_url}/telegram/webhook"

    await bot.delete_webhook(drop_pending_updates=False)
    await bot.set_webhook(
        url=webhook_url,
        allowed_updates=dp.resolve_used_update_types(),
    )

    log.info("Telegram webhook set: %s", webhook_url)
    await safe_sync(force=True)


async def on_cleanup(app: web.Application) -> None:
    await bot.session.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", root_handler)
    app.router.add_get("/health", health_handler)
    app.router.add_post("/telegram/webhook", webhook_handler)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    port = int(os.getenv("PORT", "10000"))
    web.run_app(create_app(), host="0.0.0.0", port=port)
