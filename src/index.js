import { DurableObject } from "cloudflare:workers";

const LEAGUE_ID = 19719;
const VALVE_LIVE_URL =
  "https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/";

const VALVE_HEROES_URL =
  "https://api.steampowered.com/IEconDOTA2_570/GetHeroes/v1/";

const HERO_CACHE_MS =
  24 * 60 * 60 * 1000;
const STRATZ_GRAPHQL = "https://api.stratz.com/graphql";

const TEAM_MATCH_TAKE = 5;
const TEAM_BATCH_SIZE = 5;
const CHECK_COOLDOWN_MS = 45 * 1000;

const PREDICTIONS = [
  { team: "Team Vision", kind: "4-0" },
  { team: "Team Yandex", kind: "4-1" },
  { team: "BoomBoys", kind: "4-1" },

  { team: "Aurora Gaming", kind: "elim_win" },
  { team: "Team Spirit", kind: "elim_win" },
  { team: "Iron Wing", kind: "elim_win" },
  { team: "Vici Gaming", kind: "elim_win" },
  { team: "Team Falcons", kind: "elim_win" },

  { team: "LGD Gaming", kind: "elim_loss" },
  { team: "Nigma Galaxy", kind: "elim_loss" },
  { team: "Xtreme Gaming", kind: "elim_loss" },
  { team: "OG", kind: "elim_loss" },
  { team: "Team Liquid", kind: "elim_loss" },

  { team: "GamerLegion", kind: "1-4" },
  { team: "HULIGANI", kind: "1-4" },

  { team: "Team Resilience", kind: "0-4" },
];

const ALIASES = {
  "Team Vision": [
    "Team Vision",
    "TEAM VISION",
    "Vision",
    "PARIVISION",
    "PARI VISION",
    "PVISION",
  ],

  "Team Yandex": [
    "Team Yandex",
    "Yandex",
    "Yandex Team",
  ],

  BoomBoys: [
    "BoomBoys",
    "BOOMBOYS",
    "BOOM Esports",
    "BOOM",
    "BetBoom Team",
    "BetBoom",
    "BETBOOM",
    "BB Team",
  ],

  "Aurora Gaming": [
    "Aurora Gaming",
    "Aurora",
  ],

  "Team Spirit": [
    "Team Spirit",
    "Spirit",
  ],

  "Iron Wing": [
    "Iron Wing",
    "Tundra Esports",
    "Tundra",
  ],

  "Vici Gaming": [
    "Vici Gaming",
    "VG",
  ],

  "Team Falcons": [
    "Team Falcons",
    "Falcons",
  ],

  "LGD Gaming": [
    "LGD Gaming",
    "LGD",
  ],

  "Nigma Galaxy": [
    "Nigma Galaxy",
    "Nigma",
  ],

  "Xtreme Gaming": [
    "Xtreme Gaming",
    "XG",
  ],

  OG: [
    "OG",
  ],

  "Team Liquid": [
    "Team Liquid",
    "Liquid",
  ],

  GamerLegion: [
    "GamerLegion",
    "Gamer Legion",
    "GL",
  ],

  HULIGANI: [
    "HULIGANI",
    "Huligani",
    "L1GA TEAM",
    "L1GA Team",
    "L1GA",
    "L1ga",
  ],

  "Team Resilience": [
    "Team Resilience",
    "Resilience",
    "RESILIENCE",
    "EHOME.immortal",
    "EHOME immortal",
  ],
};

const SEED_TEAM_IDS = [
  7119388,
  8261500,
  9823272,
  2163,
  9824702,
  726228,
  10136357,

  9247354,
  8255888,
  9964962,

  10150413,
  5017210,
];

const KIND_LABEL = {
  "4-0": "4-0",
  "4-1": "4-1",

  elim_win:
    "ПРОХОДЯТ РАУНД НА ВЫБЫВАНИЕ",

  elim_loss:
    "ВЫЛЕТАЮТ В РАУНДЕ НА ВЫБЫВАНИЕ",

  "1-4": "1-4",
  "0-4": "0-4",
};

const ORDER = [
  "4-0",
  "4-1",
  "elim_win",
  "elim_loss",
  "1-4",
  "0-4",
];

const STATUS_ICON = {
  won: "✅",
  lost: "❌",
  waiting: "🟡",
  alive: "🟢",
};

const aliasMap = new Map();

for (
  const [canonical, aliases]
  of Object.entries(ALIASES)
) {
  for (const alias of aliases) {
    aliasMap.set(
      normalizeName(alias),
      canonical,
    );
  }
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function canonicalTeam(value) {
  if (!value) {
    return "Unknown";
  }

  return (
    aliasMap.get(
      normalizeName(value),
    ) ||
    String(value).trim()
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonResponse(
  data,
  status = 200,
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2,
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",
      },
    },
  );
}

function textResponse(
  text,
  status = 200,
) {
  return new Response(
    text,
    {
      status,

      headers: {
        "content-type":
          "text/plain; charset=utf-8",
      },
    },
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms,
      ),
  );
}

function emptyTeamState(team) {
  return {
    team,

    swissWins: 0,
    swissLosses: 0,

    gameWins: 0,
    gameLosses: 0,

    eliminationResult:
      null,
  };
}

function pairKey(game) {
  return [
    game.radiant,
    game.dire,
  ]
    .sort()
    .join("|");
}

function buildSeries(games) {
  const bySeriesId =
    new Map();

  for (const game of games) {
    const s =
      game.series;

    if (
      !game.seriesId ||
      !s ||
      Number(
        s.leagueId,
      ) !== LEAGUE_ID
    ) {
      continue;
    }

    if (
      s.type !==
      "BEST_OF_THREE"
    ) {
      continue;
    }

    const seriesId =
      Number(
        game.seriesId,
      );

    const gameTime =
      Number(
        game.startTime ||
          0,
      );

    const stratzSeriesTime =
      Number(
        s.lastMatchDateTime ||
          0,
      );

    const existing =
      bySeriesId.get(
        seriesId,
      );

    if (!existing) {
      bySeriesId.set(
        seriesId,
        {
          series: s,

          lastGameTime:
            gameTime,

          stratzSeriesTime:
            stratzSeriesTime,
        },
      );

      continue;
    }

    existing.lastGameTime =
      Math.max(
        existing.lastGameTime,
        gameTime,
      );

    existing.stratzSeriesTime =
      Math.max(
        existing.stratzSeriesTime,
        stratzSeriesTime,
      );

    if (
      stratzSeriesTime >=
      existing.stratzSeriesTime
    ) {
      existing.series =
        s;
    }
  }

  const preliminary = [];

  for (
    const [
      seriesId,
      entry,
    ]
    of bySeriesId.entries()
  ) {
    const s =
      entry.series;

    const teamA =
      canonicalTeam(
        s.teamOne,
      );

    const teamB =
      canonicalTeam(
        s.teamTwo,
      );

    const scoreA =
      Number(
        s.teamOneWinCount ||
          0,
      );

    const scoreB =
      Number(
        s.teamTwoWinCount ||
          0,
      );

    const winningTeamId =
      Number(
        s.winningTeamId ||
          0,
      );

    if (
      !teamA ||
      !teamB ||
      teamA === "Unknown" ||
      teamB === "Unknown"
    ) {
      continue;
    }

    if (
      Math.max(
        scoreA,
        scoreB,
      ) < 2 ||
      !winningTeamId
    ) {
      continue;
    }

    const winner =
      winningTeamId ===
      Number(
        s.teamOneId,
      )
        ? teamA
        : winningTeamId ===
          Number(
            s.teamTwoId,
          )
          ? teamB
          : null;

    if (!winner) {
      continue;
    }

    const loser =
      winner === teamA
        ? teamB
        : teamA;

    const startTime =
      entry.stratzSeriesTime >
      0
        ? entry.stratzSeriesTime
        : entry.lastGameTime;

    preliminary.push({
      key:
        `series:${seriesId}`,

      seriesId,

      startTime,

      teamA,
      teamB,

      scoreA,
      scoreB,

      winner,
      loser,
    });
  }

  preliminary.sort(
    (a, b) =>
      a.startTime -
        b.startTime ||
      a.seriesId -
        b.seriesId,
  );

  const states =
    new Map();

  const results = [];

  const stateFor =
    (team) => {
      if (
        !states.has(
          team,
        )
      ) {
        states.set(
          team,
          emptyTeamState(
            team,
          ),
        );
      }

      return states.get(
        team,
      );
    };

  for (
    const s
    of preliminary
  ) {
    const a =
      stateFor(
        s.teamA,
      );

    const b =
      stateFor(
        s.teamB,
      );

    const aReady =
      a.swissWins +
        a.swissLosses >=
        5 &&
      (
        (
          a.swissWins ===
            3 &&
          a.swissLosses ===
            2
        ) ||
        (
          a.swissWins ===
            2 &&
          a.swissLosses ===
            3
        )
      );

    const bReady =
      b.swissWins +
        b.swissLosses >=
        5 &&
      (
        (
          b.swissWins ===
            3 &&
          b.swissLosses ===
            2
        ) ||
        (
          b.swissWins ===
            2 &&
          b.swissLosses ===
            3
        )
      );

    const stage =
      aReady &&
      bReady
        ? "elimination"
        : "swiss";

    results.push({
      ...s,
      stage,
    });

    if (
      stage ===
      "swiss"
    ) {
      stateFor(
        s.winner,
      ).swissWins +=
        1;

      stateFor(
        s.loser,
      ).swissLosses +=
        1;
    } else {
      stateFor(
        s.winner,
      ).eliminationResult =
        "won";

      stateFor(
        s.loser,
      ).eliminationResult =
        "lost";
    }
  }

  return results;
}

function calculateStates(
  games,
) {
  const states =
    new Map();

  for (
    const p
    of PREDICTIONS
  ) {
    states.set(
      p.team,

      emptyTeamState(
        p.team,
      ),
    );
  }

  const stateFor =
    (team) => {
      if (
        !states.has(
          team,
        )
      ) {
        states.set(
          team,

          emptyTeamState(
            team,
          ),
        );
      }

      return states.get(
        team,
      );
    };

  const series =
    buildSeries(
      games,
    );

  for (
    const s
    of series
  ) {
    const a =
      stateFor(
        s.teamA,
      );

    const b =
      stateFor(
        s.teamB,
      );

    if (
      s.stage ===
      "swiss"
    ) {
      stateFor(
        s.winner,
      ).swissWins +=
        1;

      stateFor(
        s.loser,
      ).swissLosses +=
        1;

      a.gameWins +=
        s.scoreA;

      a.gameLosses +=
        s.scoreB;

      b.gameWins +=
        s.scoreB;

      b.gameLosses +=
        s.scoreA;
    } else {
      stateFor(
        s.winner,
      ).eliminationResult =
        "won";

      stateFor(
        s.loser,
      ).eliminationResult =
        "lost";
    }
  }

  return {
    states,
    series,
  };
}

function predictionStatus(
  kind,
  state,
) {
  const w =
    state.swissWins;

  const l =
    state.swissLosses;

  if (
    kind === "4-0"
  ) {
    if (
      w === 4 &&
      l === 0
    ) {
      return [
        "won",
        "точно закончили групповой этап 4-0",
      ];
    }

    if (
      l > 0 ||
      w >= 4
    ) {
      return [
        "lost",
        `текущий счёт серий ${w}-${l}; 4-0 уже невозможно`,
      ];
    }

    return [
      "alive",
      `идут ${w}-${l}; для прогноза нужно закончить 4-0`,
    ];
  }

  if (
    kind === "4-1"
  ) {
    if (
      w === 4 &&
      l === 1
    ) {
      return [
        "won",
        "точно закончили групповой этап 4-1",
      ];
    }

    if (
      l > 1 ||
      (
        w >= 4 &&
        l !== 1
      )
    ) {
      return [
        "lost",
        `текущий счёт серий ${w}-${l}; точный 4-1 уже невозможен`,
      ];
    }

    return [
      "alive",
      `идут ${w}-${l}; точный 4-1 ещё возможен`,
    ];
  }

  if (
    kind === "1-4"
  ) {
    if (
      w === 1 &&
      l === 4
    ) {
      return [
        "won",
        "точно закончили групповой этап 1-4",
      ];
    }

    if (
      w > 1 ||
      (
        l >= 4 &&
        w !== 1
      )
    ) {
      return [
        "lost",
        `текущий счёт серий ${w}-${l}; точный 1-4 уже невозможен`,
      ];
    }

    return [
      "alive",
      `идут ${w}-${l}; точный 1-4 ещё возможен`,
    ];
  }

  if (
    kind === "0-4"
  ) {
    if (
      w === 0 &&
      l === 4
    ) {
      return [
        "won",
        "точно закончили групповой этап 0-4",
      ];
    }

    if (
      w > 0 ||
      l >= 4
    ) {
      return [
        "lost",
        `текущий счёт серий ${w}-${l}; 0-4 уже невозможно`,
      ];
    }

    return [
      "alive",
      `идут ${w}-${l}; для прогноза нужно закончить 0-4`,
    ];
  }

  if (
    kind ===
      "elim_win" ||
    kind ===
      "elim_loss"
  ) {
    const wanted =
      kind ===
      "elim_win"
        ? "won"
        : "lost";

    if (
      state.eliminationResult !==
      null
    ) {
      if (
        state.eliminationResult ===
        wanted
      ) {
        return [
          "won",

          wanted ===
          "won"
            ? "выиграли раунд на выбывание — точное попадание"
            : "проиграли раунд на выбывание — точное попадание",
        ];
      }

      return [
        "lost",

        state.eliminationResult ===
        "won"
          ? "выиграли раунд на выбывание — это противоположный исход"
          : "проиграли раунд на выбывание — это противоположный исход",
      ];
    }

    if (
      w >= 4
    ) {
      return [
        "lost",
        `закончили этап ${w}-${l} и прошли напрямую; раунда на выбывание для них не будет`,
      ];
    }

    if (
      l >= 4
    ) {
      return [
        "lost",
        `закончили этап ${w}-${l} и вылетели напрямую; раунда на выбывание для них не будет`,
      ];
    }

    if (
      w + l >= 5 &&
      (
        (
          w === 3 &&
          l === 2
        ) ||
        (
          w === 2 &&
          l === 3
        )
      )
    ) {
      return [
        "waiting",

        `закончили этап ${w}-${l}; теперь должны ${
          wanted ===
          "won"
            ? "выиграть"
            : "проиграть"
        } раунд на выбывание`,
      ];
    }

    return [
      "alive",
      `идут ${w}-${l}; пока могут попасть в раунд на выбывание`,
    ];
  }

  return [
    "alive",
    `идут ${w}-${l}`,
  ];
}

function makeSnapshot(
  games,
) {
  const {
    states,
  } =
    calculateStates(
      games,
    );

  const result = {};

  for (
    const p
    of PREDICTIONS
  ) {
    const st =
      states.get(
        p.team,
      ) ||
      emptyTeamState(
        p.team,
      );

    const [
      status,
      reason,
    ] =
      predictionStatus(
        p.kind,
        st,
      );

    result[
      p.team
    ] = {
      kind:
        p.kind,

      swissWins:
        st.swissWins,

      swissLosses:
        st.swissLosses,

      eliminationResult:
        st.eliminationResult,

      status,
      reason,
    };
  }

  return result;
}

function predictionsText() {
  const lines = [
    "🏆 <b>ТВОИ ПРОГНОЗЫ — TI 2026</b>",
  ];

  for (
    const kind
    of ORDER
  ) {
    lines.push(
      `\n<b>${KIND_LABEL[kind]}</b>`,
    );

    for (
      const p
      of PREDICTIONS
    ) {
      if (
        p.kind ===
        kind
      ) {
        lines.push(
          `• ${escapeHtml(
            p.team,
          )}`,
        );
      }
    }
  }

  return lines.join(
    "\n",
  );
}

function predictionIcon(
  status,
  state,
) {
  if (
    status === "won"
  ) {
    return "✅";
  }

  if (
    status === "lost"
  ) {
    return "🔴";
  }

  if (
    status === "waiting"
  ) {
    return "🟡";
  }

  if (
    state.swissWins ===
      0 &&
    state.swissLosses ===
      0 &&
    state.eliminationResult ===
      null
  ) {
    return "⚪";
  }

  return "🟢";
}

function compactPredictionHint(
  kind,
  state,
  status,
) {
  const w =
    state.swissWins;

  const l =
    state.swissLosses;

  if (
    status === "won"
  ) {
    return "прогноз сыграл";
  }

  if (
    status === "lost"
  ) {
    return "прогноз уже не сыграет";
  }

  if (
    status === "waiting"
  ) {
    if (
      kind ===
      "elim_win"
    ) {
      return "нужно выиграть раунд на выбывание";
    }

    if (
      kind ===
      "elim_loss"
    ) {
      return "нужно проиграть раунд на выбывание";
    }

    return "решающий этап";
  }

  if (
    kind === "4-0"
  ) {
    const remaining =
      Math.max(
        0,
        4 - w,
      );

    return (
      remaining ===
      1
        ? "осталась 1 победа"
        : `осталось побед: ${remaining}`
    );
  }

  if (
    kind === "4-1"
  ) {
    return "цель: закончить 4-1";
  }

  if (
    kind === "1-4"
  ) {
    return "цель: закончить 1-4";
  }

  if (
    kind === "0-4"
  ) {
    const remaining =
      Math.max(
        0,
        4 - l,
      );

    return (
      remaining ===
      1
        ? "осталось 1 поражение"
        : `осталось поражений: ${remaining}`
    );
  }

  return null;
}

function getValveLiveSeries(
  liveGames,
) {
  const bySeries =
    new Map();

  for (
    const game
    of (liveGames || [])
  ) {
    const seriesId =
      Number(
        game?.series_id || 0,
      );

    const radiant =
      canonicalTeam(
        game?.radiant_team
          ?.team_name ||
          "Radiant",
      );

    const dire =
      canonicalTeam(
        game?.dire_team
          ?.team_name ||
          "Dire",
      );

    if (
      !seriesId ||
      radiant === "Unknown" ||
      dire === "Unknown"
    ) {
      continue;
    }

    const radiantSeriesWins =
      Number(
        game?.radiant_series_wins ||
          0,
      );

    const direSeriesWins =
      Number(
        game?.dire_series_wins ||
          0,
      );

    const radiantMapScore =
      Number(
        game?.scoreboard
          ?.radiant
          ?.score ||
          0,
      );

    const direMapScore =
      Number(
        game?.scoreboard
          ?.dire
          ?.score ||
          0,
      );

    const duration =
      Number(
        game?.scoreboard
          ?.duration ||
          0,
      );

    bySeries.set(
      seriesId,
      {
        seriesId,

        radiant,
        dire,

        radiantSeriesWins,
        direSeriesWins,

        radiantMapScore,
        direMapScore,

        duration,

        finished:
          radiantSeriesWins >= 2 ||
          direSeriesWins >= 2,
      },
    );
  }

  return [
    ...bySeries.values(),
  ];
}

function isEliminationReady(
  state,
) {
  if (!state) {
    return false;
  }

  return (
    state.swissWins +
      state.swissLosses >=
      5 &&
    (
      (
        state.swissWins === 3 &&
        state.swissLosses === 2
      ) ||
      (
        state.swissWins === 2 &&
        state.swissLosses === 3
      )
    )
  );
}

function applyValveFinishedSeries(
  states,
  stratzSeries,
  valveSeries,
) {
  const existingSeriesIds =
    new Set(
      (stratzSeries || [])
        .map(
          (s) =>
            Number(
              s.seriesId || 0,
            ),
        )
        .filter(Boolean),
    );

  let addedSeries = 0;

  for (
    const live
    of valveSeries
  ) {
    if (
      !live.finished ||
      existingSeriesIds.has(
        live.seriesId,
      )
    ) {
      continue;
    }

    const radiantState =
      states.get(
        live.radiant,
      ) ||
      emptyTeamState(
        live.radiant,
      );

    const direState =
      states.get(
        live.dire,
      ) ||
      emptyTeamState(
        live.dire,
      );

    if (
      !states.has(
        live.radiant,
      )
    ) {
      states.set(
        live.radiant,
        radiantState,
      );
    }

    if (
      !states.has(
        live.dire,
      )
    ) {
      states.set(
        live.dire,
        direState,
      );
    }

    const winner =
      live.radiantSeriesWins >
      live.direSeriesWins
        ? live.radiant
        : live.dire;

    const loser =
      winner === live.radiant
        ? live.dire
        : live.radiant;

    const elimination =
      isEliminationReady(
        radiantState,
      ) &&
      isEliminationReady(
        direState,
      );

    if (elimination) {
      states.get(
        winner,
      ).eliminationResult =
        "won";

      states.get(
        loser,
      ).eliminationResult =
        "lost";
    } else {
      states.get(
        winner,
      ).swissWins += 1;

      states.get(
        loser,
      ).swissLosses += 1;
    }

    existingSeriesIds.add(
      live.seriesId,
    );

    addedSeries += 1;
  }

  return addedSeries;
}

function getLiveTeamInfo(
  team,
  valveSeries,
) {
  for (
    const live
    of valveSeries
  ) {
    if (
      live.finished
    ) {
      continue;
    }

    if (
      live.radiant !== team &&
      live.dire !== team
    ) {
      continue;
    }

    const isRadiant =
      live.radiant ===
      team;

    return {
      opponent:
        isRadiant
          ? live.dire
          : live.radiant,

      ourSeriesWins:
        isRadiant
          ? live.radiantSeriesWins
          : live.direSeriesWins,

      theirSeriesWins:
        isRadiant
          ? live.direSeriesWins
          : live.radiantSeriesWins,

      ourMapScore:
        isRadiant
          ? live.radiantMapScore
          : live.direMapScore,

      theirMapScore:
        isRadiant
          ? live.direMapScore
          : live.radiantMapScore,

      duration:
        live.duration,
    };
  }

  return null;
}

function liveStatusLine(
  team,
  valveSeries,
) {
  const live =
    getLiveTeamInfo(
      team,
      valveSeries,
    );

  if (!live) {
    return null;
  }

  return (
    `   🔴 <b>LIVE</b>: ` +
    `vs ${escapeHtml(
      live.opponent,
    )} · ` +
    `серия <b>${live.ourSeriesWins}:${live.theirSeriesWins}</b> · ` +
    `карта <b>${live.ourMapScore}:${live.theirMapScore}</b> · ` +
    `⏱ ${formatLiveDuration(
      live.duration,
    )}`
  );
}

function statusText(
  games,
  liveGames = [],
) {
  const {
    states,
    series,
  } =
    calculateStates(
      games,
    );

  const valveSeries =
    getValveLiveSeries(
      liveGames,
    );

  const valveFinishedSeries =
    applyValveFinishedSeries(
      states,
      series,
      valveSeries,
    );

  const getData =
    (
      team,
      kind,
    ) => {
      const state =
        states.get(
          team,
        ) ||
        emptyTeamState(
          team,
        );

      const [
        status,
      ] =
        predictionStatus(
          kind,
          state,
        );

      return {
        state,
        status,

        icon:
          predictionIcon(
            status,
            state,
          ),

        hint:
          compactPredictionHint(
            kind,
            state,
            status,
          ),
      };
    };

  const lines = [
    "🏆 <b>TI 2026 — МОИ ПРОГНОЗЫ</b>",
    "━━━━━━━━━━━━━━━━━━",
    "",
  ];

  lines.push(
    "🎯 <b>ТОЧНЫЙ СЧЁТ</b>",
    "",
    "<b>4–0</b>",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "4-0",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "<b>4–1</b>",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "4-1",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "🔥 <b>ПРОХОДЯТ РАУНД НА ВЫБЫВАНИЕ</b>",
    "",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "elim_win",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.status !==
        "alive" &&
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "💀 <b>ВЫЛЕТАЮТ В РАУНДЕ НА ВЫБЫВАНИЕ</b>",
    "",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "elim_loss",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.status !==
        "alive" &&
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "🎯 <b>ТОЧНЫЙ СЧЁТ</b>",
    "",
    "<b>1–4</b>",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "1-4",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "<b>0–4</b>",
  );

  for (
    const p
    of PREDICTIONS.filter(
      (x) =>
        x.kind ===
        "0-4",
    )
  ) {
    const d =
      getData(
        p.team,
        p.kind,
      );

    lines.push(
      `${d.icon} <b>${escapeHtml(
        p.team,
      )}</b> — <b>${d.state.swissWins}–${d.state.swissLosses}</b>`,
    );

    const liveLine =
      liveStatusLine(
        p.team,
        valveSeries,
      );
    
    if (liveLine) {
      lines.push(
        liveLine,
      );
    }

    if (
      d.hint
    ) {
      lines.push(
        `   ↳ ${escapeHtml(
          d.hint,
        )}`,
      );
    }
  }

  lines.push(
    "",
    "━━━━━━━━━━━━━━━━━━",
    "⚪ ещё не играли  ·  🟢 прогноз жив",
    "🟡 решающий этап  ·  🔴 проигран  ·  ✅ сыграл",
    "",
    `📊 Завершено серий: <b>${series.length + valveFinishedSeries}</b>`,
  );

  return lines.join(
    "\n",
  );
}

function changesText(
  oldSnapshot,
  newSnapshot,
) {
  if (
    !oldSnapshot
  ) {
    return null;
  }

  const lines = [];

  for (
    const p
    of PREDICTIONS
  ) {
    const before =
      oldSnapshot[
        p.team
      ];

    const after =
      newSnapshot[
        p.team
      ];

    if (
      !before ||
      !after
    ) {
      continue;
    }

    const significant =
      before.status !==
        after.status ||

      before.swissWins !==
        after.swissWins ||

      before.swissLosses !==
        after.swissLosses ||

      before.eliminationResult !==
        after.eliminationResult;

    if (
      !significant
    ) {
      continue;
    }

    lines.push(
      `${STATUS_ICON[
        after.status
      ] || "ℹ️"} <b>${escapeHtml(
        p.team,
      )}</b>: ` +
        `${before.swissWins}-${before.swissLosses} → ` +
        `${after.swissWins}-${after.swissLosses}\n` +
        `   ${escapeHtml(
          after.reason,
        )}`,
    );
  }

  if (
    !lines.length
  ) {
    return null;
  }

  return (
    "🚨 <b>TI 2026 — прогнозы обновились</b>\n\n" +
    lines.join(
      "\n\n",
    )
  );
}

function recentGamesText(
  games,
) {
  const series =
    buildSeries(
      games,
    );

  if (
    !series.length
  ) {
    return "Пока ни одной завершённой серии TI 2026 не найдено.";
  }

  const sorted =
    [
      ...series,
    ].sort(
      (a, b) =>
        b.startTime -
          a.startTime ||
        b.seriesId -
          a.seriesId,
    );

  const groups =
    new Map();

  const dateFormatter =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone:
          "Europe/Riga",

        day:
          "numeric",

        month:
          "long",
      },
    );

  const dateKeyFormatter =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone:
          "Europe/Riga",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",
      },
    );

  const timeFormatter =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone:
          "Europe/Riga",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hour12:
          false,
      },
    );

  for (
    const s
    of sorted
  ) {
    const date =
      new Date(
        s.startTime *
          1000,
      );

    const dateKey =
      dateKeyFormatter.format(
        date,
      );

    const dateTitle =
      dateFormatter.format(
        date,
      );

    if (
      !groups.has(
        dateKey,
      )
    ) {
      groups.set(
        dateKey,
        {
          title:
            dateTitle,

          items:
            [],
        },
      );
    }

    groups
      .get(
        dateKey,
      )
      .items
      .push(
        s,
      );
  }

  const lines = [
    "🎮 <b>TI 2026 — сыгранные серии</b>",
    "",
  ];

  for (
    const group
    of groups.values()
  ) {
    lines.push(
      `📅 <b>${escapeHtml(
        group.title,
      )}</b>`,
    );

    lines.push("");

    for (
      const s
      of group.items
    ) {
      const winner =
        s.winner;

      const loser =
        s.loser;

      let winnerScore;
      let loserScore;

      if (
        winner ===
        s.teamA
      ) {
        winnerScore =
          s.scoreA;

        loserScore =
          s.scoreB;
      } else {
        winnerScore =
          s.scoreB;

        loserScore =
          s.scoreA;
      }

      const time =
        timeFormatter.format(
          new Date(
            s.startTime *
              1000,
          ),
        );

      lines.push(
        `🕐 <b>${time}</b> · ✅ ` +
          `<b>${escapeHtml(
            winner,
          )}</b> ` +
          `<b>${winnerScore}:${loserScore}</b> ` +
          `${escapeHtml(
            loser,
          )}`,
      );
    }

    lines.push("");
  }

  lines.push(
    `Завершено серий: <b>${series.length}</b>`,
  );

  return lines.join(
    "\n",
  );
}

async function fetchValveLiveGames(env) {
  if (!env.STEAM_API_KEY) {
    throw new Error(
      "STEAM_API_KEY secret is missing",
    );
  }

  const url =
    new URL(
      VALVE_LIVE_URL,
    );

  url.searchParams.set(
    "key",
    env.STEAM_API_KEY,
  );

  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          accept:
            "application/json",
        },
      },
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Valve LIVE HTTP ${response.status}: ${text.slice(
        0,
        300,
      )}`,
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Valve LIVE returned invalid JSON",
    );
  }

  const games =
    Array.isArray(
      data?.result?.games,
    )
      ? data.result.games
      : [];

  /*
   * Только The International 2026.
   */
  return games.filter(
    (game) =>
      Number(
        game?.league_id ||
          0,
      ) === LEAGUE_ID,
  );
}

async function fetchValveHeroes(env) {
  if (!env.STEAM_API_KEY) {
    throw new Error(
      "STEAM_API_KEY secret is missing",
    );
  }

  const url =
    new URL(
      VALVE_HEROES_URL,
    );

  url.searchParams.set(
    "key",
    env.STEAM_API_KEY,
  );

  url.searchParams.set(
    "language",
    "english",
  );

  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          accept:
            "application/json",
        },
      },
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Valve GetHeroes HTTP ${response.status}: ${text.slice(
        0,
        300,
      )}`,
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Valve GetHeroes returned invalid JSON",
    );
  }

  const result = {};

  for (
    const hero
    of (
      data?.result?.heroes ||
      []
    )
  ) {
    const id =
      Number(
        hero?.id || 0,
      );

    if (!id) {
      continue;
    }

    result[id] =
      hero.localized_name ||
      hero.name ||
      `Hero ${id}`;
  }

  return result;
}

function formatLiveDuration(seconds) {
  const total =
    Math.max(
      0,
      Math.floor(
        Number(
          seconds || 0,
        ),
      ),
    );

  const minutes =
    Math.floor(
      total / 60,
    );

  const secs =
    total % 60;

  return (
    `${minutes}:` +
    String(
      secs,
    ).padStart(
      2,
      "0",
    )
  );
}

function formatNW(value) {
  const n =
    Number(
      value || 0,
    );

  if (
    Math.abs(n) >=
    1000
  ) {
    return (
      `${(
        n / 1000
      ).toFixed(1)}k`
    );
  }

  return String(n);
}

function getValvePlayerNames(game) {
  const map =
    new Map();

  for (
    const player
    of (
      game?.players ||
      []
    )
  ) {
    const accountId =
      Number(
        player?.account_id ||
          0,
      );

    if (
      accountId &&
      player?.name
    ) {
      map.set(
        accountId,
        String(
          player.name,
        ),
      );
    }
  }

  return map;
}

function getLivePlayers(
  side,
  playerNames,
  heroNames,
) {
  return (
    Array.isArray(
      side?.players,
    )
      ? side.players
      : []
  ).map(
    (player) => {
      const heroId =
        Number(
          player?.hero_id ||
            0,
        );

      const accountId =
        Number(
          player?.account_id ||
            0,
        );

      return {
        playerName:
          playerNames.get(
            accountId,
          ) ||
          `Player ${accountId}`,

        heroName:
          heroNames[
            heroId
          ] ||
          (
            heroId
              ? `Hero ${heroId}`
              : "Не выбран"
          ),

        kills:
          Number(
            player?.kills ||
              0,
          ),

        deaths:
          Number(
            player?.death ||
              0,
          ),

        assists:
          Number(
            player?.assists ||
              0,
          ),

        level:
          Number(
            player?.level ||
              0,
          ),

        networth:
          Number(
            player?.net_worth ||
              0,
          ),

        gpm:
          Number(
            player?.gold_per_min ||
              0,
          ),

        xpm:
          Number(
            player?.xp_per_min ||
              0,
          ),
      };
    },
  );
}

function getTeamNetworth(side) {
  return (
    side?.players ||
    []
  ).reduce(
    (
      total,
      player,
    ) =>
      total +
      Number(
        player?.net_worth ||
          0,
      ),
    0,
  );
}

function buildValveLiveGameText(
  game,
  heroNames,
) {
  const radiantName =
    canonicalTeam(
      game?.radiant_team
        ?.team_name ||
        "Radiant",
    );

  const direName =
    canonicalTeam(
      game?.dire_team
        ?.team_name ||
        "Dire",
    );

  const scoreboard =
    game?.scoreboard ||
    {};

  const radiant =
    scoreboard?.radiant ||
    {};

  const dire =
    scoreboard?.dire ||
    {};

  const radiantScore =
    Number(
      radiant?.score ||
        0,
    );

  const direScore =
    Number(
      dire?.score ||
        0,
    );

  const radiantSeries =
    Number(
      game?.radiant_series_wins ||
        0,
    );

  const direSeries =
    Number(
      game?.dire_series_wins ||
        0,
    );

  const duration =
    formatLiveDuration(
      scoreboard?.duration ||
        0,
    );

  const names =
    getValvePlayerNames(
      game,
    );

  const radiantPlayers =
    getLivePlayers(
      radiant,
      names,
      heroNames,
    );

  const direPlayers =
    getLivePlayers(
      dire,
      names,
      heroNames,
    );

  const radiantNW =
    getTeamNetworth(
      radiant,
    );

  const direNW =
    getTeamNetworth(
      dire,
    );

  const diff =
    radiantNW -
    direNW;

  let leadText =
    "по золоту примерно равно";

  if (diff > 0) {
    leadText =
      `${radiantName} +${formatNW(
        diff,
      )}`;
  } else if (diff < 0) {
    leadText =
      `${direName} +${formatNW(
        Math.abs(diff),
      )}`;
  }

  const lines = [
    `⚔️ <b>${escapeHtml(
      radiantName,
    )} ${radiantScore}:${direScore} ${escapeHtml(
      direName,
    )}</b>`,

    `⏱ <b>${duration}</b> · серия <b>${radiantSeries}:${direSeries}</b>`,

    `💰 ${escapeHtml(
      leadText,
    )}`,

    "",
  ];

  /*
   * Radiant
   */
  lines.push(
    `🟢 <b>${escapeHtml(
      radiantName,
    )}</b> · NW ${formatNW(
      radiantNW,
    )}`,
  );

  if (
    radiantPlayers.length
  ) {
    for (
      const p
      of radiantPlayers
    ) {
      lines.push(
        `• <b>${escapeHtml(
          p.heroName,
        )}</b> — ` +
          `${escapeHtml(
            p.playerName,
          )} · ` +
          `${p.kills}/${p.deaths}/${p.assists} · ` +
          `${formatNW(
            p.networth,
          )}`,
      );
    }
  } else {
    lines.push(
      "• данные игроков пока недоступны",
    );
  }

  lines.push("");

  /*
   * Dire
   */
  lines.push(
    `🔴 <b>${escapeHtml(
      direName,
    )}</b> · NW ${formatNW(
      direNW,
    )}`,
  );

  if (
    direPlayers.length
  ) {
    for (
      const p
      of direPlayers
    ) {
      lines.push(
        `• <b>${escapeHtml(
          p.heroName,
        )}</b> — ` +
          `${escapeHtml(
            p.playerName,
          )} · ` +
          `${p.kills}/${p.deaths}/${p.assists} · ` +
          `${formatNW(
            p.networth,
          )}`,
      );
    }
  } else {
    lines.push(
      "• данные игроков пока недоступны",
    );
  }

  /*
   * Match ID специально НЕ показываем.
   */
  return lines.join(
    "\n",
  );
}

function telegramKeyboard() {
  return {
    keyboard: [
      [
        {
          text:
            "📊 Статус",
        },

        {
          text:
            "🎯 Мои прогнозы",
        },
      ],

      [
        {
          text:
            "🎮 Результаты серий",
        },

        {
          text:
            "🔴 LIVE матчи",
        },
      ],

      [
        {
          text:
            "🔄 Проверить сейчас",
        },
      ],
    ],

    resize_keyboard:
      true,
  };
}

async function telegramCall(
  env,
  method,
  body,
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,

      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body:
          JSON.stringify(
            body,
          ),
      },
    );

  const data =
    await response.json();

  if (
    !data.ok
  ) {
    throw new Error(
      `Telegram ${method}: ${JSON.stringify(
        data,
      )}`,
    );
  }

  return data.result;
}

async function sendTelegram(
  env,
  chatId,
  text,
  replyMarkup = null,
) {
  const body = {
    chat_id:
      chatId,

    text,

    parse_mode:
      "HTML",

    disable_web_page_preview:
      true,
  };

  if (
    replyMarkup
  ) {
    body.reply_markup =
      replyMarkup;
  }

  return telegramCall(
    env,
    "sendMessage",
    body,
  );
}

async function stratzQuery(
  env,
  query,
) {
  if (
    !env.STRATZ_TOKEN
  ) {
    throw new Error(
      "STRATZ_TOKEN secret is missing",
    );
  }

  console.log(
    "=== STRATZ GRAPHQL QUERY START ===",
  );

  console.log(
    query,
  );

  console.log(
    "=== STRATZ GRAPHQL QUERY END ===",
  );

  const response =
    await fetch(
      STRATZ_GRAPHQL,

      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",

          accept:
            "application/json",

          authorization:
            `Bearer ${env.STRATZ_TOKEN}`,

          "user-agent":
            "TI2026PredictionBot/6.0",
        },

        body:
          JSON.stringify({
            query,
          }),
      },
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `STRATZ HTTP ${response.status}: ${text.slice(
        0,
        300,
      )}`,
    );
  }

  let payload;

  try {
    payload =
      JSON.parse(
        text,
      );
  } catch {
    throw new Error(
      `STRATZ returned invalid JSON: ${text.slice(
        0,
        300,
      )}`,
    );
  }

  if (
    payload.errors
      ?.length
  ) {
    throw new Error(
      "STRATZ GraphQL: " +
        payload.errors
          .map(
            (x) =>
              x.message,
          )
          .join(
            " | ",
          ),
    );
  }

  return payload.data;
}

function parseStratzMatch(
  raw,
) {
  if (
    !raw?.id ||
    Number(
      raw.leagueId,
    ) !== LEAGUE_ID
  ) {
    return null;
  }

  const radiant =
    canonicalTeam(
      raw.radiantTeam
        ?.name,
    );

  const dire =
    canonicalTeam(
      raw.direTeam
        ?.name,
    );

  if (
    radiant ===
      "Unknown" ||
    dire ===
      "Unknown"
  ) {
    return null;
  }

  const radiantWin =
    Boolean(
      raw.didRadiantWin,
    );

  return {
    matchId:
      Number(
        raw.id,
      ),

    seriesId:
      raw.seriesId
        ? Number(
            raw.seriesId,
          )
        : null,

    series:
      raw.series
        ? {
            id:
              Number(
                raw.series.id,
              ),

            type:
              raw.series.type ||
              null,

            leagueId:
              Number(
                raw.series.leagueId ||
                  0,
              ),

            teamOneId:
              Number(
                raw.series.teamOneId ||
                  0,
              ),

            teamTwoId:
              Number(
                raw.series.teamTwoId ||
                  0,
              ),

            teamOne:
              canonicalTeam(
                raw.series
                  .teamOne
                  ?.name,
              ),

            teamTwo:
              canonicalTeam(
                raw.series
                  .teamTwo
                  ?.name,
              ),

            teamOneWinCount:
              Number(
                raw.series
                  .teamOneWinCount ||
                  0,
              ),

            teamTwoWinCount:
              Number(
                raw.series
                  .teamTwoWinCount ||
                  0,
              ),

            winningTeamId:
              raw.series
                .winningTeamId
                ? Number(
                    raw.series
                      .winningTeamId,
                  )
                : null,

            lastMatchDateTime:
              Number(
                raw.series
                  .lastMatchDateTime ||
                  0,
              ),
          }
        : null,

    startTime:
      Number(
        raw.startDateTime ||
          0,
      ),

    duration:
      0,

    radiant,
    dire,

    radiantTeamId:
      Number(
        raw.radiantTeamId ||
          raw.radiantTeam
            ?.id ||
          0,
      ),

    direTeamId:
      Number(
        raw.direTeamId ||
          raw.direTeam
            ?.id ||
          0,
      ),

    radiantWin,

    winner:
      radiantWin
        ? radiant
        : dire,

    leagueId:
      LEAGUE_ID,

    leagueName:
      "The International 2026",
  };
}

async function fetchTeamsMatches(
  env,
  teamIds,
) {
  const ids = [
    ...new Set(
      teamIds
        .map(
          Number,
        )
        .filter(
          (id) =>
            Number.isFinite(
              id,
            ) &&
            id > 0,
        ),
    ),
  ];

  if (
    !ids.length
  ) {
    return [];
  }

  const query = `{
    teams(teamIds: [${ids.join(",")}]) {
      id
      name

      matches(
        request: {
          take: ${TEAM_MATCH_TAKE}
          skip: 0
        }
      ) {
        id
        startDateTime
        leagueId
        seriesId

        radiantTeamId
        direTeamId
        didRadiantWin

        radiantTeam {
          id
          name
        }

        direTeam {
          id
          name
        }

        series {
          id
          type
          leagueId

          teamOneId
          teamTwoId
          teamOneWinCount
          teamTwoWinCount
          winningTeamId
          lastMatchDateTime

          teamOne {
            id
            name
          }

          teamTwo {
            id
            name
          }
        }
      }
    }
  }`;

  const data =
    await stratzQuery(
      env,
      query,
    );

  return Array.isArray(
    data?.teams,
  )
    ? data.teams
    : [];
}

async function fetchCurrentTIGames(
  env,
  knownIds,
) {
  const ids = [
    ...new Set(
      [
        ...SEED_TEAM_IDS,
        ...(
          knownIds ||
          []
        ),
      ]
        .map(
          Number,
        )
        .filter(
          (id) =>
            Number.isFinite(
              id,
            ) &&
            id > 0,
        ),
    ),
  ];

  const byId =
    new Map();

  const discoveredIds =
    new Set(
      ids,
    );

  for (
    let offset = 0;
    offset <
    ids.length;
    offset +=
      TEAM_BATCH_SIZE
  ) {
    const batch =
      ids.slice(
        offset,
        offset +
          TEAM_BATCH_SIZE,
      );

    if (
      !batch.length
    ) {
      continue;
    }

    const teams =
      await fetchTeamsMatches(
        env,
        batch,
      );

    for (
      const team
      of teams
    ) {
      const teamId =
        Number(
          team?.id ||
            0,
        );

      if (
        teamId > 0
      ) {
        discoveredIds.add(
          teamId,
        );
      }

      for (
        const raw
        of (
          team?.matches ||
          []
        )
      ) {
        const radiantId =
          Number(
            raw.radiantTeamId ||
              raw.radiantTeam
                ?.id ||
              0,
          );

        const direId =
          Number(
            raw.direTeamId ||
              raw.direTeam
                ?.id ||
              0,
          );

        if (
          radiantId >
          0
        ) {
          discoveredIds.add(
            radiantId,
          );
        }

        if (
          direId >
          0
        ) {
          discoveredIds.add(
            direId,
          );
        }

        if (
          Number(
            raw.leagueId,
          ) !==
          LEAGUE_ID
        ) {
          continue;
        }

        const game =
          parseStratzMatch(
            raw,
          );

        if (
          !game
        ) {
          continue;
        }

        byId.set(
          Number(
            game.matchId,
          ),
          game,
        );
      }
    }
  }

  return {
    games: [
      ...byId.values(),
    ].sort(
      (a, b) =>
        a.startTime -
          b.startTime ||
        a.matchId -
          b.matchId,
    ),

    teamIds: [
      ...discoveredIds,
    ],
  };
}

function teamsDebugText(
  games,
) {
  const names =
    new Set();

  for (
    const game
    of games
  ) {
    if (
      game.radiant
    ) {
      names.add(
        game.radiant,
      );
    }

    if (
      game.dire
    ) {
      names.add(
        game.dire,
      );
    }
  }

  const sorted =
    [
      ...names,
    ].sort(
      (
        a,
        b,
      ) =>
        a.localeCompare(
          b,
        ),
    );

  if (
    !sorted.length
  ) {
    return "Команды пока не найдены.";
  }

  return (
    "🧪 <b>Canonical teams</b>\n\n" +
    sorted
      .map(
        (x) =>
          `• ${escapeHtml(
            x,
          )}`,
      )
      .join(
        "\n",
      )
  );
}

export class BotState
  extends DurableObject {
  constructor(
    ctx,
    env,
  ) {
    super(
      ctx,
      env,
    );

    this.ctx =
      ctx;

    this.env =
      env;
  }

  async registerChat(
    chatId,
  ) {
    const stored =
      (
        await this.ctx.storage.get(
          "subscriberChatIds",
        )
      ) || [];

    const chats = [
      ...new Set(
        stored
          .map(
            Number,
          )
          .filter(
            (id) =>
              Number.isFinite(
                id,
              ) &&
              id !== 0,
          ),
      ),
    ];

    const id =
      Number(
        chatId,
      );

    if (
      Number.isFinite(
        id,
      ) &&
      id !== 0 &&
      !chats.includes(
        id,
      )
    ) {
      chats.push(
        id,
      );

      await this.ctx.storage.put(
        "subscriberChatIds",
        chats,
      );
    }

    return chats;
  }

  async getSubscriberChats() {
    const stored =
      (
        await this.ctx.storage.get(
          "subscriberChatIds",
        )
      ) || [];

    return [
      ...new Set(
        stored
          .map(
            Number,
          )
          .filter(
            (id) =>
              Number.isFinite(
                id,
              ) &&
              id !== 0,
          ),
      ),
    ];
  }

  async getHeroNames() {
    const cached =
      await this.ctx.storage.get(
        "valveHeroNames",
      );
  
    const cachedAt =
      Number(
        (
          await this.ctx.storage.get(
            "valveHeroNamesAt",
          )
        ) || 0,
      );
  
    /*
     * Используем кэш сутки.
     */
    if (
      cached &&
      Date.now() -
        cachedAt <
        HERO_CACHE_MS
    ) {
      return cached;
    }
  
    const heroes =
      await fetchValveHeroes(
        this.env,
      );
  
    await this.ctx.storage.put(
      "valveHeroNames",
      heroes,
    );
  
    await this.ctx.storage.put(
      "valveHeroNamesAt",
      Date.now(),
    );
  
    return heroes;
  }

  async getGames() {
    return (
      (
        await this.ctx.storage.get(
          "games",
        )
      ) || []
    );
  }

  async sync(
    notify = false,
  ) {
    const existing =
      await this.getGames();

    const knownTeamIds =
      (
        await this.ctx.storage.get(
          "knownTeamIds",
        )
      ) ||
      SEED_TEAM_IDS;

    const incoming =
      await fetchCurrentTIGames(
        this.env,
        knownTeamIds,
      );

    const byId =
      new Map(
        existing.map(
          (g) => [
            Number(
              g.matchId,
            ),
            g,
          ],
        ),
      );

    for (
      const g
      of incoming.games
    ) {
      byId.set(
        Number(
          g.matchId,
        ),
        g,
      );
    }

    const games = [
      ...byId.values(),
    ].sort(
      (a, b) =>
        a.startTime -
          b.startTime ||
        a.matchId -
          b.matchId,
    );

    const oldSnapshot =
      await this.ctx.storage.get(
        "snapshot",
      );

    const newSnapshot =
      makeSnapshot(
        games,
      );

    await this.ctx.storage.put(
      "games",
      games,
    );

    await this.ctx.storage.put(
      "snapshot",
      newSnapshot,
    );

    await this.ctx.storage.put(
      "knownTeamIds",
      incoming.teamIds,
    );

    await this.ctx.storage.put(
      "lastSync",
      Date.now(),
    );

    await this.ctx.storage.delete(
      "lastError",
    );

    const changes =
      changesText(
        oldSnapshot,
        newSnapshot,
      );

    const subscriberChats =
      await this.getSubscriberChats();

    if (
      notify &&
      changes &&
      subscriberChats.length
    ) {
      for (
        const subscriberChatId
        of subscriberChats
      ) {
        try {
          await sendTelegram(
            this.env,

            subscriberChatId,

            changes,

            telegramKeyboard(),
          );
        } catch (
          error
        ) {
          console.error(
            `Telegram notification failed for chat ${subscriberChatId}:`,
            error,
          );
        }
      }
    }

    return {
      source:
        "STRATZ",

      leagueId:
        LEAGUE_ID,

      games:
        games.length,

      newGames:
        Math.max(
          0,
          games.length -
            existing.length,
        ),

      knownTeams:
        incoming
          .teamIds
          .length,

      changes:
        Boolean(
          changes,
        ),
    };
  }

  async safeSync(
    notify = false,
  ) {
    try {
      return await this.sync(
        notify,
      );
    } catch (
      error
    ) {
      await this.ctx.storage.put(
        "lastError",

        String(
          error,
        ),
      );

      console.error(
        error,
      );

      return {
        source:
          "STRATZ",

        leagueId:
          LEAGUE_ID,

        games:
          (
            await this.getGames()
          ).length,

        newGames:
          0,

        changes:
          false,

        error:
          String(
            error,
          ),
      };
    }
  }

  async handleTelegram(
    update,
  ) {
    const updateId =
      Number(
        update?.update_id,
      );

    if (
      Number.isFinite(
        updateId,
      )
    ) {
      const lastUpdateId =
        Number(
          (
            await this.ctx.storage.get(
              "lastTelegramUpdateId",
            )
          ) ?? -1,
        );

      if (
        updateId <=
        lastUpdateId
      ) {
        return {
          ok: true,
          duplicate: true,
        };
      }

      await this.ctx.storage.put(
        "lastTelegramUpdateId",
        updateId,
      );
    }

    const message =
      update?.message;

    if (
      !message
    ) {
      return {
        ok: true,
      };
    }

    const chatId =
      Number(
        message.chat?.id ||
          0,
      );

    const text =
      String(
        message.text ||
          "",
      ).trim();

    if (
      !chatId
    ) {
      return {
        ok: true,
      };
    }

    await this.registerChat(
      chatId,
    );

    if (
      text ===
      "/start"
    ) {
      const games =
        await this.getGames();

      await sendTelegram(
        this.env,

        chatId,

        "🏆 <b>TI 2026 Prediction Bot</b>\n\n" +
          "Бот следит за The International 2026 через <b>STRATZ</b>.\n" +
          "Все функции доступны всем пользователям и группам.\n\n" +
          "📊 <b>Статус</b> — текущее состояние прогнозов\n" +
          "🎯 <b>Мои прогнозы</b> — полный список прогнозов\n" +
          "🎮 <b>Результаты серий</b> — сыгранные серии по дням\n" +
          "🔴 <b>LIVE матчи</b> — текущие карты, герои и статистика\n" +
          "🔄 <b>Проверить сейчас</b> — обновить результаты STRATZ\n\n" +
          `Сейчас сохранено карт: <b>${games.length}</b>`,

        telegramKeyboard(),
      );

      return {
        ok: true,
      };
    }

    if (
      text ===
        "/predictions" ||
      text ===
        "🎯 Мои прогнозы"
    ) {
      await sendTelegram(
        this.env,

        chatId,

        predictionsText(),

        telegramKeyboard(),
      );

      return {
        ok: true,
      };
    }

    if (
      text ===
        "/status" ||
      text ===
        "📊 Статус"
    ) {
      const games =
        await this.getGames();

      let liveGames = [];

      try {
        liveGames =
          await fetchValveLiveGames(
            this.env,
          );
      } catch (error) {
        console.error(
          "Valve status overlay failed:",
          error,
        );
      }

      if (
        !games.length
      ) {
        const error =
          (
            await this.ctx.storage.get(
              "lastError",
            )
          ) ||
          "матчи пока не получены";

        await sendTelegram(
          this.env,

          chatId,

          `⚠️ Пока нет сохранённых матчей TI 2026.\nПоследняя ошибка:\n<code>${escapeHtml(
            error,
          )}</code>`,

          telegramKeyboard(),
        );
      } else {
        await sendTelegram(
          this.env,

          chatId,

          statusText(
            games,
            liveGames,
          ),

          telegramKeyboard(),
        );
      }

      return {
        ok: true,
      };
    }

    if (
      text ===
        "/matches" ||
      text ===
        "🎮 Результаты серий" ||
      text ===
        "🎮 Последние матчи"
    ) {
      await sendTelegram(
        this.env,

        chatId,

        recentGamesText(
          await this.getGames(),
        ),

        telegramKeyboard(),
      );

      return {
        ok: true,
      };
    }

    if (
      text ===
      "/teams"
    ) {
      await sendTelegram(
        this.env,

        chatId,

        teamsDebugText(
          await this.getGames(),
        ),

        telegramKeyboard(),
      );

      return {
        ok: true,
      };
    }

    if (
      text === "/live" ||
      text ===
        "🔴 LIVE матчи"
    ) {
      try {
        const [
          liveGames,
          heroNames,
        ] =
          await Promise.all([
            fetchValveLiveGames(
              this.env,
            ),
    
            this.getHeroNames(),
          ]);
    
        if (
          !liveGames.length
        ) {
          await sendTelegram(
            this.env,
    
            chatId,
    
            "🔴 <b>TI 2026 — LIVE</b>\n\n" +
              "Сейчас активных карт TI 2026 нет.",
    
            telegramKeyboard(),
          );
    
          return {
            ok: true,
          };
        }
    
        /*
         * Заголовок отдельным сообщением.
         */
        await sendTelegram(
          this.env,
    
          chatId,
    
          "🔴 <b>TI 2026 — LIVE</b>\n\n" +
            `Сейчас играют карт: <b>${liveGames.length}</b>`,
    
          telegramKeyboard(),
        );
    
        /*
         * Каждая карта отдельным сообщением.
         *
         * Так мы не упираемся в лимит Telegram
         * на длину сообщения, если одновременно
         * идёт 4-5 матчей.
         */
        for (
          const game
          of liveGames
        ) {
          await sendTelegram(
            this.env,
    
            chatId,
    
            buildValveLiveGameText(
              game,
              heroNames,
            ),
    
            telegramKeyboard(),
          );
        }
      } catch (error) {
        console.error(
          "Valve LIVE error:",
          error,
        );
    
        await sendTelegram(
          this.env,
    
          chatId,
    
          "⚠️ <b>Не удалось получить LIVE-матчи.</b>\n\n" +
            `<code>${escapeHtml(
              String(error),
            )}</code>`,
    
          telegramKeyboard(),
        );
      }
    
      return {
        ok: true,
      };
    }

    if (
      text ===
        "/check" ||
      text ===
        "🔄 Проверить сейчас"
    ) {
      const now =
        Date.now();

      const lastManualCheckAt =
        Number(
          (
            await this.ctx.storage.get(
              "lastManualCheckAt",
            )
          ) || 0,
        );

      const elapsed =
        now -
        lastManualCheckAt;

      if (
        lastManualCheckAt >
          0 &&
        elapsed <
          CHECK_COOLDOWN_MS
      ) {
        const secondsLeft =
          Math.max(
            1,

            Math.ceil(
              (
                CHECK_COOLDOWN_MS -
                elapsed
              ) /
                1000,
            ),
          );

        const games =
          await this.getGames();

        let liveGames = [];
        
        try {
          liveGames =
            await fetchValveLiveGames(
              this.env,
            );
        } catch (error) {
          console.error(
            "Valve cooldown status overlay failed:",
            error,
          );
        }

        await sendTelegram(
          this.env,

          chatId,

          `⏱ Данные уже недавно обновлялись. Новую проверку можно запустить через <b>${secondsLeft} сек.</b>`,

          telegramKeyboard(),
        );

        if (
          games.length
        ) {
          await sendTelegram(
            this.env,

            chatId,

            statusText(
              games,
              liveGames,
            ),

            telegramKeyboard(),
          );
        }

        return {
          ok: true,
          cooldown: true,
        };
      }

      await this.ctx.storage.put(
        "lastManualCheckAt",
        now,
      );

      const checkStartedAt =
        Date.now();

      await sendTelegram(
        this.env,

        chatId,

        "🔄 Проверяю TI 2026 через STRATZ…",

        telegramKeyboard(),
      );

      const result =
        await this.safeSync(
          true,
        );

      const checkSeconds =
        (
          (
            Date.now() -
            checkStartedAt
          ) /
            1000
        ).toFixed(
          1,
        );

      const games =
        await this.getGames();

      let liveGames = [];
      
      try {
        liveGames =
          await fetchValveLiveGames(
            this.env,
          );
      } catch (error) {
        console.error(
          "Valve status overlay after check failed:",
          error,
        );
      }

      await sendTelegram(
        this.env,

        chatId,

        result.error
          ? `⚠️ Проверка закончилась с ошибкой:\n<code>${escapeHtml(
              result.error,
            )}</code>`

          : `✅ Готово.
          Источник: <b>STRATZ</b>
          League ID: <code>${LEAGUE_ID}</code>
          Карт сохранено: <b>${result.games}</b>
          Новых карт: <b>${result.newGames}</b>
          Известно team ID: <b>${result.knownTeams}</b>
          Время проверки: <b>${checkSeconds} сек.</b>`,

        telegramKeyboard(),
      );

      if (
        games.length
      ) {
        await sendTelegram(
          this.env,

          chatId,

          statusText(
            games,
            liveGames,
          ),

          telegramKeyboard(),
        );
      }

      return {
        ok: true,
      };
    }

    await sendTelegram(
      this.env,

      chatId,

      "Используй кнопки снизу или команды:\n" +
        "/status\n" +
        "/predictions\n" +
        "/matches\n" +
        "/live\n" +
        "/check\n" +
        "/teams",

      telegramKeyboard(),
    );

    return {
      ok: true,
    };
  }

  async fetch(
    request,
  ) {
    const url =
      new URL(
        request.url,
      );

    if (
      url.pathname ===
        "/telegram" &&
      request.method ===
        "POST"
    ) {
      return jsonResponse(
        await this.handleTelegram(
          await request.json(),
        ),
      );
    }

    if (
      url.pathname ===
      "/sync"
    ) {
      return jsonResponse(
        await this.safeSync(
          url.searchParams.get(
            "notify",
          ) === "1",
        ),
      );
    }

    if (
      url.pathname ===
      "/health"
    ) {
      const games =
        await this.getGames();

      const {
        series,
      } =
        calculateStates(
          games,
        );

      return jsonResponse({
        ok:
          true,

        source:
          "STRATZ",

        leagueId:
          LEAGUE_ID,

        games:
          games.length,

        series:
          series.length,

        knownTeams:
          (
            (
              await this.ctx.storage.get(
                "knownTeamIds",
              )
            ) ||
            SEED_TEAM_IDS
          ).length,

        subscribers:
          (
            await this.getSubscriberChats()
          ).length,

        lastSync:
          (
            await this.ctx.storage.get(
              "lastSync",
            )
          ) ||
          null,

        lastError:
          (
            await this.ctx.storage.get(
              "lastError",
            )
          ) ||
          null,
      });
    }

    return textResponse(
      "Not found",
      404,
    );
  }
}

export default {
  async fetch(
    request,
    env,
  ) {
    const url =
      new URL(
        request.url,
      );

    const state =
      env.BOT_STATE.getByName(
        "ti2026",
      );

    if (
      url.pathname ===
        "/telegram/webhook" &&
      request.method ===
        "POST"
    ) {
      return state.fetch(
        new Request(
          "https://state.internal/telegram",

          {
            method:
              "POST",

            headers: {
              "content-type":
                "application/json",
            },

            body:
              await request.text(),
          },
        ),
      );
    }

    if (
      url.pathname ===
      "/setup"
    ) {
      if (
        !env.BOT_TOKEN
      ) {
        return jsonResponse(
          {
            ok:
              false,

            error:
              "BOT_TOKEN secret is missing",
          },

          500,
        );
      }

      const webhookUrl =
        `${url.origin}/telegram/webhook`;

      const result =
        await telegramCall(
          env,

          "setWebhook",

          {
            url:
              webhookUrl,

            allowed_updates: [
              "message",
            ],

            drop_pending_updates:
              false,
          },
        );

      return jsonResponse({
        ok:
          true,

        webhook:
          webhookUrl,

        result,
      });
    }

    if (
      url.pathname ===
      "/health"
    ) {
      return state.fetch(
        new Request(
          "https://state.internal/health",
        ),
      );
    }

    if (
      url.pathname ===
      "/check"
    ) {
      return state.fetch(
        new Request(
          "https://state.internal/sync",
        ),
      );
    }

    return textResponse(
      "TI 2026 Prediction Bot is running.",
    );
  },

  async scheduled(
    controller,
    env,
    ctx,
  ) {
    const state =
      env.BOT_STATE.getByName(
        "ti2026",
      );

    ctx.waitUntil(
      state.fetch(
        new Request(
          "https://state.internal/sync?notify=1",
        ),
      ),
    );
  },
};
