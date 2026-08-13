from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class PredictionKind(str, Enum):
    EXACT_4_0 = "4-0"
    EXACT_4_1 = "4-1"
    ELIMINATION_WIN = "elim_win"
    ELIMINATION_LOSS = "elim_loss"
    EXACT_1_4 = "1-4"
    EXACT_0_4 = "0-4"


@dataclass(frozen=True)
class TeamPrediction:
    team: str
    kind: PredictionKind


# Прогнозы перенесены со скриншота пользователя.
PREDICTIONS: tuple[TeamPrediction, ...] = (
    TeamPrediction("Team Vision", PredictionKind.EXACT_4_0),
    TeamPrediction("Team Yandex", PredictionKind.EXACT_4_1),
    TeamPrediction("BoomBoys", PredictionKind.EXACT_4_1),

    TeamPrediction("Aurora Gaming", PredictionKind.ELIMINATION_WIN),
    TeamPrediction("Team Spirit", PredictionKind.ELIMINATION_WIN),
    TeamPrediction("Iron Wing", PredictionKind.ELIMINATION_WIN),
    TeamPrediction("Vici Gaming", PredictionKind.ELIMINATION_WIN),
    TeamPrediction("Team Falcons", PredictionKind.ELIMINATION_WIN),

    TeamPrediction("LGD Gaming", PredictionKind.ELIMINATION_LOSS),
    TeamPrediction("Nigma Galaxy", PredictionKind.ELIMINATION_LOSS),
    TeamPrediction("Xtreme Gaming", PredictionKind.ELIMINATION_LOSS),
    TeamPrediction("OG", PredictionKind.ELIMINATION_LOSS),
    TeamPrediction("Team Liquid", PredictionKind.ELIMINATION_LOSS),

    TeamPrediction("GamerLegion", PredictionKind.EXACT_1_4),
    TeamPrediction("HULIGANI", PredictionKind.EXACT_1_4),
    TeamPrediction("Team Resilience", PredictionKind.EXACT_0_4),
)


# Один и тот же состав иногда называется по-разному в Dota-клиенте и статистических API.
ALIASES: dict[str, tuple[str, ...]] = {
    "Team Vision": ("Team Vision", "TEAM VISION", "Vision", "PARIVISION", "PARI VISION"),
    "Team Yandex": ("Team Yandex", "Yandex", "Yandex Team"),
    "BoomBoys": ("BoomBoys", "BOOMBOYS", "BOOM Esports", "BOOM"),
    "Aurora Gaming": ("Aurora Gaming", "Aurora"),
    "Team Spirit": ("Team Spirit", "Spirit"),
    "Iron Wing": ("Iron Wing",),
    "Vici Gaming": ("Vici Gaming", "VG"),
    "Team Falcons": ("Team Falcons", "Falcons"),
    "LGD Gaming": ("LGD Gaming", "LGD"),
    "Nigma Galaxy": ("Nigma Galaxy", "Nigma"),
    "Xtreme Gaming": ("Xtreme Gaming", "XG"),
    "OG": ("OG",),
    "Team Liquid": ("Team Liquid", "Liquid"),
    "GamerLegion": ("GamerLegion", "Gamer Legion", "GL"),
    "HULIGANI": ("HULIGANI", "Huligani"),
    "Team Resilience": ("Team Resilience", "Resilience"),
}


def normalize_name(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


_ALIAS_TO_CANONICAL = {
    normalize_name(alias): canonical
    for canonical, aliases in ALIASES.items()
    for alias in aliases
}


def canonical_team(value: str | None) -> str:
    if not value:
        return "Unknown"
    return _ALIAS_TO_CANONICAL.get(normalize_name(value), value.strip())
