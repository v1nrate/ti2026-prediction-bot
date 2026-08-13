from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Game:
    match_id: int
    series_id: int | None
    start_time: int
    duration: int
    radiant: str
    dire: str
    radiant_win: bool
    league_id: int
    league_name: str

    @property
    def winner(self) -> str:
        return self.radiant if self.radiant_win else self.dire

    @property
    def loser(self) -> str:
        return self.dire if self.radiant_win else self.radiant


@dataclass
class TeamState:
    team: str
    swiss_wins: int = 0
    swiss_losses: int = 0
    game_wins: int = 0
    game_losses: int = 0
    elimination_result: str | None = None  # "won" | "lost"

    @property
    def swiss_played(self) -> int:
        return self.swiss_wins + self.swiss_losses


@dataclass(frozen=True)
class SeriesResult:
    series_key: str
    start_time: int
    team_a: str
    team_b: str
    score_a: int
    score_b: int
    winner: str
    loser: str
    stage: str  # swiss | elimination
