from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict

from .models import Game, SeriesResult, TeamState
from .predictions import PREDICTIONS, PredictionKind


ALL_PREDICTED_TEAMS = {p.team for p in PREDICTIONS}


def _fallback_series_key(game: Game) -> str:
    pair = "|".join(sorted((game.radiant, game.dire)))
    # In case series_id is missing, bucket nearby games of the same pair into 6-hour windows.
    bucket = game.start_time // (6 * 3600) if game.start_time else game.match_id
    return f"fallback:{pair}:{bucket}"


def build_series(games: list[Game]) -> list[SeriesResult]:
    grouped: dict[str, list[Game]] = defaultdict(list)
    for g in games:
        key = f"series:{g.series_id}" if g.series_id else _fallback_series_key(g)
        grouped[key].append(g)

    preliminary = []
    for key, items in grouped.items():
        items = sorted(items, key=lambda x: (x.start_time, x.match_id))
        teams = sorted({x.radiant for x in items} | {x.dire for x in items})
        if len(teams) != 2:
            continue
        a, b = teams
        score_a = sum(1 for x in items if x.winner == a)
        score_b = sum(1 for x in items if x.winner == b)
        # Group stage and elimination round are BO3. A completed series has a side on 2 wins.
        if max(score_a, score_b) < 2:
            continue
        winner = a if score_a > score_b else b
        loser = b if winner == a else a
        preliminary.append((key, items[0].start_time, a, b, score_a, score_b, winner, loser))

    preliminary.sort(key=lambda x: (x[1], x[0]))

    states: dict[str, TeamState] = {}
    results: list[SeriesResult] = []
    for key, start, a, b, sa, sb, winner, loser in preliminary:
        state_a = states.setdefault(a, TeamState(team=a))
        state_b = states.setdefault(b, TeamState(team=b))

        # After five Swiss series, 3-2 and 2-3 teams play one elimination series.
        a_ready = state_a.swiss_played >= 5 and (state_a.swiss_wins, state_a.swiss_losses) in {(3, 2), (2, 3)}
        b_ready = state_b.swiss_played >= 5 and (state_b.swiss_wins, state_b.swiss_losses) in {(3, 2), (2, 3)}
        stage = "elimination" if a_ready and b_ready else "swiss"

        results.append(
            SeriesResult(
                series_key=key,
                start_time=start,
                team_a=a,
                team_b=b,
                score_a=sa,
                score_b=sb,
                winner=winner,
                loser=loser,
                stage=stage,
            )
        )

        if stage == "swiss":
            states[winner].swiss_wins += 1
            states[loser].swiss_losses += 1
            states[a].game_wins += sa
            states[a].game_losses += sb
            states[b].game_wins += sb
            states[b].game_losses += sa
        else:
            states[winner].elimination_result = "won"
            states[loser].elimination_result = "lost"

    return results


def calculate_states(games: list[Game]) -> tuple[dict[str, TeamState], list[SeriesResult]]:
    states = {team: TeamState(team=team) for team in ALL_PREDICTED_TEAMS}
    series = build_series(games)
    for s in series:
        for team in (s.team_a, s.team_b):
            states.setdefault(team, TeamState(team=team))
        if s.stage == "swiss":
            states[s.winner].swiss_wins += 1
            states[s.loser].swiss_losses += 1
            if s.team_a == s.winner:
                states[s.team_a].game_wins += s.score_a
                states[s.team_a].game_losses += s.score_b
                states[s.team_b].game_wins += s.score_b
                states[s.team_b].game_losses += s.score_a
            else:
                states[s.team_a].game_wins += s.score_a
                states[s.team_a].game_losses += s.score_b
                states[s.team_b].game_wins += s.score_b
                states[s.team_b].game_losses += s.score_a
        else:
            states[s.winner].elimination_result = "won"
            states[s.loser].elimination_result = "lost"
    return states, series


def prediction_status(kind: PredictionKind, state: TeamState) -> tuple[str, str]:
    w, l = state.swiss_wins, state.swiss_losses

    if kind == PredictionKind.EXACT_4_0:
        if w == 4 and l == 0:
            return "won", "точно закончили Swiss 4-0"
        if l > 0 or w >= 4:
            return "lost", f"текущий Swiss-счёт {w}-{l}; 4-0 уже невозможно"
        return "alive", f"идут {w}-{l}; для прогноза нужно закончить 4-0"

    if kind == PredictionKind.EXACT_4_1:
        if w == 4 and l == 1:
            return "won", "точно закончили Swiss 4-1"
        if l > 1 or (w >= 4 and l != 1):
            return "lost", f"текущий Swiss-счёт {w}-{l}; точный 4-1 уже невозможен"
        return "alive", f"идут {w}-{l}; точный 4-1 ещё возможен"

    if kind == PredictionKind.EXACT_1_4:
        if w == 1 and l == 4:
            return "won", "точно закончили Swiss 1-4"
        if w > 1 or (l >= 4 and w != 1):
            return "lost", f"текущий Swiss-счёт {w}-{l}; точный 1-4 уже невозможен"
        return "alive", f"идут {w}-{l}; точный 1-4 ещё возможен"

    if kind == PredictionKind.EXACT_0_4:
        if w == 0 and l == 4:
            return "won", "точно закончили Swiss 0-4"
        if w > 0 or l >= 4:
            return "lost", f"текущий Swiss-счёт {w}-{l}; 0-4 уже невозможно"
        return "alive", f"идут {w}-{l}; для прогноза нужно закончить 0-4"

    # These two categories specifically mean reaching 3-2/2-3 and then the elimination round.
    if kind in (PredictionKind.ELIMINATION_WIN, PredictionKind.ELIMINATION_LOSS):
        wanted = "won" if kind == PredictionKind.ELIMINATION_WIN else "lost"
        if state.elimination_result is not None:
            if state.elimination_result == wanted:
                text = "выиграли" if wanted == "won" else "проиграли"
                return "won", f"{text} раунд на выбывание — точное попадание"
            text = "выиграли" if state.elimination_result == "won" else "проиграли"
            return "lost", f"{text} раунд на выбывание — это противоположный исход"

        if w >= 4:
            return "lost", f"закончили Swiss {w}-{l} и прошли напрямую; раунда на выбывание для них не будет"
        if l >= 4:
            return "lost", f"закончили Swiss {w}-{l} и вылетели напрямую; раунда на выбывание для них не будет"

        if state.swiss_played >= 5 and (w, l) in {(3, 2), (2, 3)}:
            action = "выиграть" if wanted == "won" else "проиграть"
            return "waiting", f"закончили Swiss {w}-{l}; теперь должны {action} раунд на выбывание"

        return "alive", f"идут {w}-{l}; пока могут попасть в раунд на выбывание"

    return "alive", f"идут {w}-{l}"


def snapshot(games: list[Game]) -> dict:
    states, _ = calculate_states(games)
    data = {}
    for p in PREDICTIONS:
        state = states[p.team]
        status, reason = prediction_status(p.kind, state)
        data[p.team] = {
            "kind": p.kind.value,
            "swiss_wins": state.swiss_wins,
            "swiss_losses": state.swiss_losses,
            "elimination_result": state.elimination_result,
            "status": status,
            "reason": reason,
        }
    return data
