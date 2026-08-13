import { DurableObject } from "cloudflare:workers";

const LEAGUE_ID = 19719;
const STRATZ_GRAPHQL = "https://api.stratz.com/graphql";

const TEAM_MATCH_TAKE = 5;
const TEAM_BATCH_SIZE = 5;
const MAX_MATCH_PAGES = 6;
const MAX_DISCOVERY_ROUNDS = 4;

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
  ],

  "Team Resilience": [
    "Team Resilience",
    "Resilience",
  ],
};

const SEED_TEAM_IDS = [
  7119388,  // Team Spirit
  8261500,  // Xtreme Gaming
  9823272,  // Team Yandex
  2163,     // Team Liquid
  9824702,  // PVISION
  726228,   // Vici Gaming
  10136357, // Nigma Galaxy
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
  if (!value) return "Unknown";

  return (
    aliasMap.get(normalizeName(value)) ||
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
    JSON.stringify(data, null, 2),
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

function emptyTeamState(team) {
  return {
    team,

    swissWins: 0,
    swissLosses: 0,

    gameWins: 0,
    gameLosses: 0,

    eliminationResult: null,
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
  const groupedByPair = new Map();

  for (const game of games) {
    const pair = pairKey(game);

    if (!groupedByPair.has(pair)) {
      groupedByPair.set(pair, []);
    }

    groupedByPair
      .get(pair)
      .push(game);
  }

  const preliminary = [];

  for (
    const [pair, pairGames]
    of groupedByPair.entries()
  ) {
    const sorted = [
      ...pairGames,
    ].sort(
      (a, b) =>
        a.startTime -
          b.startTime ||
        a.matchId -
          b.matchId,
    );

    const clusters = [];

    let current = [];

    for (const game of sorted) {
      if (!current.length) {
        current = [game];
        continue;
      }

      const previous =
        current[current.length - 1];

      const sameSeriesWindow =
        game.startTime -
          previous.startTime <=
        4 * 3600;

      if (sameSeriesWindow) {
        current.push(game);
      } else {
        clusters.push(current);
        current = [game];
      }
    }

    if (current.length) {
      clusters.push(current);
    }

    for (const items of clusters) {
      const teams = [
        ...new Set(
          items.flatMap(
            (x) => [
              x.radiant,
              x.dire,
            ],
          ),
        ),
      ].sort();

      if (teams.length !== 2) {
        continue;
      }

      const [a, b] = teams;

      const scoreA =
        items.filter(
          (x) =>
            x.winner === a,
        ).length;

      const scoreB =
        items.filter(
          (x) =>
            x.winner === b,
        ).length;

      /*
       * Сейчас текущая стадия TI —
       * серии BO3.
       *
       * Серия считается законченной,
       * когда одна команда выиграла
       * минимум 2 карты.
       */
      if (
        Math.max(
          scoreA,
          scoreB,
        ) < 2
      ) {
        continue;
      }

      const winner =
        scoreA > scoreB
          ? a
          : b;

      const loser =
        winner === a
          ? b
          : a;

      preliminary.push({
        key:
          `${pair}:` +
          `${items[0].startTime}`,

        startTime:
          items[0].startTime,

        teamA: a,
        teamB: b,

        scoreA,
        scoreB,

        winner,
        loser,
      });
    }
  }

  preliminary.sort(
    (a, b) =>
      a.startTime -
        b.startTime ||
      a.key.localeCompare(
        b.key,
      ),
  );

  const states =
    new Map();

  const results = [];

  const stateFor =
    (team) => {
      if (
        !states.has(team)
      ) {
        states.set(
          team,
          emptyTeamState(team),
        );
      }

      return states.get(team);
    };

  for (
    const s
    of preliminary
  ) {
    const a =
      stateFor(s.teamA);

    const b =
      stateFor(s.teamB);

    const aReady =
      a.swissWins +
        a.swissLosses >=
        5 &&
      (
        (
          a.swissWins === 3 &&
          a.swissLosses === 2
        ) ||
        (
          a.swissWins === 2 &&
          a.swissLosses === 3
        )
      );

    const bReady =
      b.swissWins +
        b.swissLosses >=
        5 &&
      (
        (
          b.swissWins === 3 &&
          b.swissLosses === 2
        ) ||
        (
          b.swissWins === 2 &&
          b.swissLosses === 3
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
      stage === "swiss"
    ) {
      stateFor(
        s.winner,
      ).swissWins += 1;

      stateFor(
        s.loser,
      ).swissLosses += 1;
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

function calculateStates(games) {
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
        !states.has(team)
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
    buildSeries(games);

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
      s.stage === "swiss"
    ) {
      stateFor(
        s.winner,
      ).swissWins += 1;

      stateFor(
        s.loser,
      ).swissLosses += 1;

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
    kind === "elim_win" ||
    kind === "elim_loss"
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
          wanted === "won"
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

    if (w >= 4) {
      return [
        "lost",
        `закончили этап ${w}-${l} и прошли напрямую; раунда на выбывание для них не будет`,
      ];
    }

    if (l >= 4) {
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
          wanted === "won"
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

    result[p.team] = {
      kind: p.kind,

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
        p.kind === kind
      ) {
        lines.push(
          `• ${escapeHtml(p.team)}`,
        );
      }
    }
  }

  return lines.join(
    "\n",
  );
}

function statusText(
  games,
) {
  const {
    states,
    series,
  } =
    calculateStates(
      games,
    );

  const lines = [
    "🏆 <b>TI 2026 — состояние прогнозов</b>",

    `Источник: <b>STRATZ</b> · карт: <b>${games.length}</b> · завершено серий: <b>${series.length}</b>`,
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
        p.kind !== kind
      ) {
        continue;
      }

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
          kind,
          st,
        );

      lines.push(
        `${STATUS_ICON[status]} <b>${escapeHtml(p.team)}</b> — ${st.swissWins}-${st.swissLosses}`,
      );

      lines.push(
        `   ${escapeHtml(reason)}`,
      );
    }
  }

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
      `${STATUS_ICON[after.status] || "ℹ️"} <b>${escapeHtml(p.team)}</b>: ` +
        `${before.swissWins}-${before.swissLosses} → ` +
        `${after.swissWins}-${after.swissLosses}\n` +
        `   ${escapeHtml(after.reason)}`,
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
  limit = 10,
) {
  if (
    !games.length
  ) {
    return (
      "Пока ни одной карты TI 2026 не сохранено."
    );
  }

  const sorted = [
    ...games,
  ]
    .sort(
      (a, b) =>
        b.startTime -
          a.startTime ||
        b.matchId -
          a.matchId,
    )
    .slice(
      0,
      limit,
    );

  const lines = [
    "🎮 <b>Последние карты TI 2026</b>",
  ];

  for (
    const g
    of sorted
  ) {
    lines.push(
      `\n${g.radiantWin ? "✅" : "❌"} ${escapeHtml(g.radiant)}\n` +
        `${g.radiantWin ? "❌" : "✅"} ${escapeHtml(g.dire)}\n` +
        `match ${g.matchId}`,
    );
  }

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
            "🎮 Последние матчи",
        },

        {
          text:
            "🔄 Проверить сейчас",
        },
      ],
    ],

    resize_keyboard: true,
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
      `Telegram ${method}: ${JSON.stringify(data)}`,
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
            "TI2026PredictionBot/5.0",
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
      `STRATZ HTTP ${response.status}: ${text.slice(0, 300)}`,
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
      `STRATZ returned invalid JSON: ${text.slice(0, 300)}`,
    );
  }

  if (
    payload.errors?.length
  ) {
    throw new Error(
      "STRATZ GraphQL: " +
        payload.errors
          .map(
            (x) =>
              x.message,
          )
          .join(" | "),
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
      Number(raw.id),

    seriesId:
      null,

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
  skip = 0,
) {
  const ids = [
    ...new Set(
      teamIds
        .map(Number)
        .filter(
          Number.isFinite,
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
          skip: ${skip}
        }
      ) {
        id
        startDateTime
        leagueId

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

async function fetchTeamBatchHistory(
  env,
  teamIds,
) {
  const matchesByTeam =
    new Map();

  for (
    let page = 0;
    page <
    MAX_MATCH_PAGES;
    page += 1
  ) {
    const skip =
      page *
      TEAM_MATCH_TAKE;

    const teams =
      await fetchTeamsMatches(
        env,
        teamIds,
        skip,
      );

    if (
      !teams.length
    ) {
      break;
    }

    let anyFullPage =
      false;

    for (
      const team
      of teams
    ) {
      const teamId =
        Number(
          team.id,
        );

      const matches =
        Array.isArray(
          team.matches,
        )
          ? team.matches
          : [];

      if (
        !matchesByTeam.has(
          teamId,
        )
      ) {
        matchesByTeam.set(
          teamId,
          [],
        );
      }

      matchesByTeam
        .get(teamId)
        .push(
          ...matches,
        );

      if (
        matches.length ===
        TEAM_MATCH_TAKE
      ) {
        anyFullPage =
          true;
      }
    }

    /*
     * Если ни одна команда
     * не заполнила страницу,
     * старых матчей дальше,
     * скорее всего, уже нет.
     */
    if (
      !anyFullPage
    ) {
      break;
    }
  }

  return [
    ...matchesByTeam
      .entries(),
  ].map(
    ([
      id,
      matches,
    ]) => ({
      id,
      matches,
    }),
  );
}

async function fetchCurrentTIGames(
  env,
  knownIds,
) {
  const known =
    new Set(
      [
        ...SEED_TEAM_IDS,
        ...(knownIds || []),
      ].map(Number),
    );

  const processed =
    new Set();

  const byId =
    new Map();

  let frontier = [
    ...known,
  ];

  for (
    let round = 0;

    round <
      MAX_DISCOVERY_ROUNDS &&
    frontier.length;

    round += 1
  ) {
    const batch =
      frontier
        .filter(
          (id) =>
            !processed.has(
              id,
            ),
        )
        .slice(
          0,
          TEAM_BATCH_SIZE,
        );

    if (
      !batch.length
    ) {
      break;
    }

    batch.forEach(
      (id) =>
        processed.add(
          id,
        ),
    );

    const teams =
      await fetchTeamBatchHistory(
        env,
        batch,
      );

    const next = [];

    for (
      const team
      of teams
    ) {
      for (
        const raw
        of team.matches ||
        []
      ) {
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

        if (game) {
          byId.set(
            game.matchId,
            game,
          );
        }

        for (
          const id
          of [
            raw.radiantTeamId,
            raw.direTeamId,
          ]
        ) {
          const n =
            Number(id);

          if (
            Number.isFinite(
              n,
            ) &&
            n > 0 &&
            !known.has(
              n,
            )
          ) {
            known.add(
              n,
            );

            next.push(
              n,
            );
          }
        }
      }
    }

    frontier = [
      ...new Set([
        ...frontier.filter(
          (id) =>
            !processed.has(
              id,
            ),
        ),

        ...next,
      ]),
    ];
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
      ...known,
    ],
  };
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

    this.ctx = ctx;
    this.env = env;
  }

  async getOwnerId() {
    const configured =
      String(
        this.env
          .ADMIN_USER_ID ||
          "",
      ).trim();

    if (
      configured
    ) {
      return Number(
        configured,
      );
    }

    return (
      (
        await this.ctx.storage.get(
          "ownerId",
        )
      ) ?? null
    );
  }

  async claimOwner(
    userId,
  ) {
    const configured =
      String(
        this.env
          .ADMIN_USER_ID ||
          "",
      ).trim();

    if (
      configured
    ) {
      return (
        Number(
          configured,
        ) ===
        Number(
          userId,
        )
      );
    }

    const existing =
      await this.ctx.storage.get(
        "ownerId",
      );

    if (
      existing == null
    ) {
      await this.ctx.storage.put(
        "ownerId",
        Number(
          userId,
        ),
      );

      return true;
    }

    return (
      Number(
        existing,
      ) ===
      Number(
        userId,
      )
    );
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

    const ownerId =
      await this.getOwnerId();

    if (
      notify &&
      changes &&
      ownerId
    ) {
      await sendTelegram(
        this.env,
        ownerId,
        changes,
        telegramKeyboard(),
      );
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
          .teamIds.length,

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
      return (
        await this.sync(
          notify,
        )
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
    const message =
      update?.message;

    if (
      !message?.chat
        ?.id ||
      !message?.from
        ?.id
    ) {
      return {
        ok: true,
      };
    }

    const chatId =
      Number(
        message.chat.id,
      );

    const userId =
      Number(
        message.from.id,
      );

    const text =
      String(
        message.text ||
          "",
      ).trim();

    if (
      text === "/start"
    ) {
      const allowed =
        await this.claimOwner(
          userId,
        );

      if (
        !allowed
      ) {
        return {
          ok: true,
        };
      }

      const sync =
        await this.safeSync(
          false,
        );

      await sendTelegram(
        this.env,

        chatId,

        "🏆 <b>TI 2026 Prediction Bot</b>\n\n" +
          "Источник матчей: <b>STRATZ</b>.\n" +
          "Я автоматически проверяю турнир каждые 5 минут и сообщаю, когда состояние твоих прогнозов меняется.\n\n" +
          `Твой Telegram ID: <code>${userId}</code>\n` +
          `Сейчас сохранено карт: <b>${sync.games}</b>`,

        telegramKeyboard(),
      );

      return {
        ok: true,
      };
    }

    const ownerId =
      await this.getOwnerId();

    if (
      !ownerId ||
      Number(
        ownerId,
      ) !==
        userId
    ) {
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
      await this.safeSync(
        false,
      );

      const games =
        await this.getGames();

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

          `⚠️ Не удалось получить матчи TI 2026:\n<code>${escapeHtml(error)}</code>`,

          telegramKeyboard(),
        );
      } else {
        await sendTelegram(
          this.env,

          chatId,

          statusText(
            games,
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
        "🎮 Последние матчи"
    ) {
      await this.safeSync(
        false,
      );

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
        "/check" ||
      text ===
        "🔄 Проверить сейчас"
    ) {
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

      const games =
        await this.getGames();

      await sendTelegram(
        this.env,

        chatId,

        result.error
          ? `⚠️ Проверка закончилась с ошибкой:\n<code>${escapeHtml(result.error)}</code>`

          : `✅ Готово.\nИсточник: <b>STRATZ</b>\nLeague ID: <code>${LEAGUE_ID}</code>\nКарт сохранено: <b>${result.games}</b>\nНовых карт: <b>${result.newGames}</b>\nНайдено команд: <b>${result.knownTeams}</b>`,

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

      "Используй кнопки снизу или команды:\n/status\n/predictions\n/matches\n/check",

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

      return jsonResponse({
        ok:
          true,

        source:
          "STRATZ",

        leagueId:
          LEAGUE_ID,

        games:
          games.length,

        knownTeams:
          (
            (
              await this.ctx.storage.get(
                "knownTeamIds",
              )
            ) ||
            SEED_TEAM_IDS
          ).length,

        ownerId:
          await this.getOwnerId(),

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
