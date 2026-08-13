from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    bot_token: str
    admin_user_id: int | None
    check_interval_seconds: int
    opendota_league_id: int | None
    opendota_api_key: str | None
    render_external_url: str


def _optional_int(name: str) -> int | None:
    value = os.getenv(name, "").strip()
    return int(value) if value else None


def get_settings() -> Settings:
    bot_token = os.getenv("BOT_TOKEN", "").strip()
    if not bot_token:
        raise RuntimeError("Environment variable BOT_TOKEN is required")

    render_external_url = os.getenv("RENDER_EXTERNAL_URL", "").strip()
    if not render_external_url:
        raise RuntimeError(
            "Environment variable RENDER_EXTERNAL_URL is required. "
            "Example: https://ti2026-prediction-bot.onrender.com"
        )

    return Settings(
        bot_token=bot_token,
        admin_user_id=_optional_int("ADMIN_USER_ID"),
        check_interval_seconds=max(
            60, int(os.getenv("CHECK_INTERVAL_SECONDS", "120"))
        ),
        opendota_league_id=_optional_int("OPENDOTA_LEAGUE_ID"),
        opendota_api_key=os.getenv("OPENDOTA_API_KEY", "").strip() or None,
        render_external_url=render_external_url,
    )
