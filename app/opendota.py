from __future__ import annotations

import asyncio

import aiohttp

from .models import Game
from .predictions import canonical_team


class OpenDotaError(RuntimeError):
    pass


class OpenDotaClient:
    BASE = "https://api.opendota.com/api"

    def __init__(self, api_key: str | None = None, league_id: int | None = None):
        self.api_key = api_key
        self.configured_league_id = league_id
        self.detected_league_id: int | None = league_id

    def _params(self) -> dict[str, str]:
        return {"api_key": self.api_key} if self.api_key else {}

    async def _get_json(self, session: aiohttp.ClientSession, path: str):
        url = f"{self.BASE}{path}"
        try:
            async with session.get(
                url,
                params=self._params(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                if response.status != 200:
                    body = (await response.text())[:300]
                    raise OpenDotaError(
                        f"OpenDota HTTP {response.status}: {body}"
                    )
                return await response.json()
        except asyncio.TimeoutError as exc:
            raise OpenDotaError("OpenDota request timed out") from exc
        except aiohttp.ClientError as exc:
            raise OpenDotaError(f"Ошибка сети OpenDota: {exc}") from exc

    @staticmethod
    def _looks_like_ti_2026(name: str) -> bool:
        n = (name or "").lower().strip()
        return (
            "the international 2026" in n
            and "qualifier" not in n
            and "qualification" not in n
            and "open qualifier" not in n
            and "closed qualifier" not in n
            and "regional" not in n
        )

    def _parse_game(self, raw: dict, league_id_hint: int | None = None) -> Game | None:
        try:
            league_id = int(
                raw.get("leagueid")
                or raw.get("league_id")
                or league_id_hint
                or 0
            )
            league_name = str(raw.get("league_name") or raw.get("league") or "")

            radiant = canonical_team(
                raw.get("radiant_name")
                or (raw.get("radiant_team") or {}).get("name")
            )
            dire = canonical_team(
                raw.get("dire_name")
                or (raw.get("dire_team") or {}).get("name")
            )

            if not radiant or not dire or radiant == "Unknown" or dire == "Unknown":
                return None

            return Game(
                match_id=int(raw["match_id"]),
                series_id=(int(raw["series_id"]) if raw.get("series_id") else None),
                start_time=int(raw.get("start_time") or 0),
                duration=int(raw.get("duration") or 0),
                radiant=radiant,
                dire=dire,
                radiant_win=bool(raw.get("radiant_win")),
                league_id=league_id,
                league_name=league_name,
            )
        except (KeyError, TypeError, ValueError):
            return None

    async def fetch_ti_games(self) -> tuple[int, list[Game]]:
        headers = {
            "User-Agent": "TI2026PredictionBot/2.0",
            "Accept": "application/json",
        }

        async with aiohttp.ClientSession(headers=headers) as session:
            recent = await self._get_json(session, "/proMatches")
            if not isinstance(recent, list):
                raise OpenDotaError("OpenDota /proMatches вернул неожиданный формат")

            league_id = self.detected_league_id

            if league_id is None:
                candidates: list[int] = []
                for item in recent:
                    if self._looks_like_ti_2026(str(item.get("league_name") or "")):
                        lid = item.get("leagueid") or item.get("league_id")
                        if lid:
                            candidates.append(int(lid))
                if candidates:
                    league_id = max(set(candidates), key=candidates.count)
                    self.detected_league_id = league_id

            raw_games: list[dict] = []

            if league_id is not None:
                try:
                    league_matches = await self._get_json(
                        session, f"/leagues/{league_id}/matches"
                    )
                    if isinstance(league_matches, list):
                        raw_games.extend(league_matches)
                except OpenDotaError:
                    # We still have /proMatches as a fallback.
                    pass

            # Important: even if the league endpoint returns an empty list,
            # merge matching /proMatches results instead of accepting 0 games.
            for item in recent:
                item_lid = int(
                    item.get("leagueid")
                    or item.get("league_id")
                    or -1
                )
                if (
                    (league_id is not None and item_lid == league_id)
                    or self._looks_like_ti_2026(str(item.get("league_name") or ""))
                ):
                    raw_games.append(item)

            # Deduplicate before parsing.
            by_match_id: dict[int, dict] = {}
            for item in raw_games:
                try:
                    by_match_id[int(item["match_id"])] = item
                except (KeyError, TypeError, ValueError):
                    pass

            parsed = [
                self._parse_game(item, league_id_hint=league_id)
                for item in by_match_id.values()
            ]
            games = [game for game in parsed if game is not None]
            games.sort(key=lambda g: (g.start_time, g.match_id))

            if league_id is None and games:
                league_id = games[0].league_id
                self.detected_league_id = league_id

            if league_id is None:
                raise OpenDotaError(
                    "Не удалось найти The International 2026 в OpenDota. "
                    "Укажи OPENDOTA_LEAGUE_ID вручную в Render."
                )

            if not games:
                raise OpenDotaError(
                    f"Лига {league_id} найдена, но OpenDota пока не вернула "
                    "ни одной карты с названиями команд."
                )

            return league_id, games
