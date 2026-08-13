from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .models import Game
from .predictions import PREDICTIONS, PredictionKind
from .tournament import calculate_states, prediction_status

STATUS_ICON = {
    "won": "✅",
    "lost": "❌",
    "waiting": "🟡",
    "alive": "🟢",
}

KIND_LABEL = {
    PredictionKind.EXACT_4_0: "4-0",
    PredictionKind.EXACT_4_1: "4-1",
    PredictionKind.ELIMINATION_WIN: "ПРОХОДЯТ РАУНД НА ВЫБЫВАНИЕ",
    PredictionKind.ELIMINATION_LOSS: "ВЫЛЕТАЮТ В РАУНДЕ НА ВЫБЫВАНИЕ",
    PredictionKind.EXACT_1_4: "1-4",
    PredictionKind.EXACT_0_4: "0-4",
}

ORDER = [
    PredictionKind.EXACT_4_0,
    PredictionKind.EXACT_4_1,
    PredictionKind.ELIMINATION_WIN,
    PredictionKind.ELIMINATION_LOSS,
    PredictionKind.EXACT_1_4,
    PredictionKind.EXACT_0_4,
]


def predictions_text() -> str:
    lines = ["🏆 <b>ТВОИ ПРОГНОЗЫ — TI 2026</b>"]
    for kind in ORDER:
        lines.append(f"\n<b>{KIND_LABEL[kind]}</b>")
        for p in PREDICTIONS:
            if p.kind == kind:
                lines.append(f"• {p.team}")
    return "\n".join(lines)


def status_text(games: list[Game]) -> str:
    states, series = calculate_states(games)
    lines = [
        "🏆 <b>TI 2026 — состояние прогнозов</b>",
        f"Сохранено карт: <b>{len(games)}</b> · завершено серий: <b>{len(series)}</b>",
    ]
    for kind in ORDER:
        lines.append(f"\n<b>{KIND_LABEL[kind]}</b>")
        for p in PREDICTIONS:
            if p.kind != kind:
                continue
            st = states[p.team]
            status, reason = prediction_status(kind, st)
            lines.append(f"{STATUS_ICON[status]} <b>{p.team}</b> — {st.swiss_wins}-{st.swiss_losses}")
            lines.append(f"   {reason}")
    return "\n".join(lines)


def changes_text(old: dict, new: dict) -> str | None:
    lines = []
    for p in PREDICTIONS:
        before = old.get(p.team)
        after = new.get(p.team)
        if not after:
            continue
        if before == after:
            continue
        if before is None:
            continue
        significant = (
            before.get("status") != after.get("status")
            or before.get("swiss_wins") != after.get("swiss_wins")
            or before.get("swiss_losses") != after.get("swiss_losses")
            or before.get("elimination_result") != after.get("elimination_result")
        )
        if significant:
            icon = STATUS_ICON.get(after["status"], "ℹ️")
            lines.append(
                f"{icon} <b>{p.team}</b>: "
                f"{before.get('swiss_wins', 0)}-{before.get('swiss_losses', 0)} → "
                f"{after['swiss_wins']}-{after['swiss_losses']}\n"
                f"   {after['reason']}"
            )
    if not lines:
        return None
    return "🚨 <b>TI 2026 — прогнозы обновились</b>\n\n" + "\n\n".join(lines)


def recent_games_text(games: list[Game], limit: int = 10) -> str:
    if not games:
        return "Пока ни одной карты TI 2026 не сохранено."
    lines = ["🎮 <b>Последние карты TI 2026</b>"]
    for g in sorted(games, key=lambda x: (x.start_time, x.match_id), reverse=True)[:limit]:
        icon_r = "✅" if g.radiant_win else "❌"
        icon_d = "❌" if g.radiant_win else "✅"
        duration = f"{g.duration // 60}:{g.duration % 60:02d}" if g.duration else "?"
        when = datetime.fromtimestamp(g.start_time, ZoneInfo("Europe/Riga")).strftime("%d.%m %H:%M") if g.start_time else ""
        lines.append(f"\n{icon_r} {g.radiant}\n{icon_d} {g.dire}\n{duration} · {when} · match {g.match_id}")
    return "\n".join(lines)
