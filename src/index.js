import { DurableObject } from "cloudflare:workers";

const LEAGUE_ID = 19719;
const STRATZ_GRAPHQL = "https://api.stratz.com/graphql";

const TEAM_MATCH_TAKE = 5;
const TEAM_BATCH_SIZE = 5;

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
  7119388,  // Team Spirit
  8261500,  // Xtreme Gaming
  9823272,  // Team Yandex
  2163,     // Team Liquid
  9824702,  // PVISION
  726228,   // Vici Gaming
  10136357, // Nigma Galaxy

  9247354,  // Team Falcons
  8255888,  // BetBoom Team
  9964962,  // GamerLegion

  10150413, // Tundra Esports -> Iron Wing
  5017210,  // EHOME.immortal -> Team Resilience
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

for (const [canonical, aliases] of Object.entries(ALIASES)) {
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

function jsonResponse(data, status = 200) {
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

function textResponse(text, status = 200) {
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
    (resolve) => setTimeout(resolve, ms),
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
  const bySeriesId = new Map();

  for (const game of games) {
    const s = game.series;

    if (
      !game.seriesId ||
      !s ||
      Number(s.leagueId) !== LEAGUE_ID
    ) {
      continue;
    }

    if (
      s.type !== "BEST_OF_THREE"
    ) {
      continue;
    }

    bySeriesId.set(
      Number(game.seriesId),
      s,
    );
  }

  const preliminary = [];

  for (
    const [
      seriesId,
      s,
    ]
    of bySeriesId.entries()
  ) {
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
        s.teamOneWinCount || 0,
      );

    const scoreB =
      Number(
        s.teamTwoWinCount || 0,
      );

    const winningTeamId =
      Number(
        s.winningTeamId || 0,
      );

    if (
      !teamA ||
      !teamB ||
      teamA === "Unknown" ||
      teamB === "Unknown"
    ) {
      continue;
    }

    /*
     * Для BO3 завершённая серия —
     * кто-то набрал 2 победы.
     */
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
      Number(s.teamOneId)
        ? teamA
        : winningTeamId ===
          Number(s.teamTwoId)
        ? teamB
        : null;

    if (!winner) {
      continue;
    }

    const loser =
      winner === teamA
        ? teamB
        : teamA;

    preliminary.push({
      key:
        `series:${seriesId}`,
    
      seriesId,
    
      startTime:
        Number(
          s.lastMatchDateTime || 0,
        ),
    
      teamA,
      teamB,
    
      scoreA,
      scoreB,
    
      winner,
      loser,
    });
  }

  /*
   * Пока порядок можно взять
   * по seriesId.
   * Позже можем сохранить
   * lastMatchDateTime из SeriesType
   * и сортировать по нему.
   */
  preliminary.sort(
    (a, b) =>
      a.seriesId -
      b.seriesId,
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

  for (const s of preliminary) {
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

  const stateFor = (team) => {
    if (!states.has(team)) {
      states.set(
        team,
        emptyTeamState(
          team,
        ),
      );
    }

    return states.get(team);
  };

  const series =
    buildSeries(games);

  for (const s of series) {
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

function recentGamesText(games) {
  const series =
    buildSeries(games);

  if (!series.length) {
    return (
      "Пока ни одной завершённой серии TI 2026 не найдено."
    );
  }

  const sorted =
    [...series].sort(
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

  for (const s of sorted) {
    const date =
      new Date(
        s.startTime * 1000,
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
      !groups.has(dateKey)
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
      .get(dateKey)
      .items
      .push(s);
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
      `📅 <b>${escapeHtml(group.title)}</b>`,
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
        winner === s.teamA
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
        `<b>${escapeHtml(winner)}</b> ` +
        `<b>${winnerScore}:${loserScore}</b> ` +
        `${escapeHtml(loser)}`,
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

  console.log(
    "=== STRATZ GRAPHQL QUERY START ===",
  );

  console.log(query);

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

  // дальше оставляешь весь свой текущий код

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
      raw.seriesId
        ? Number(raw.seriesId)
        : null,
    
    series:
      raw.series
        ? {
            id: Number(raw.series.id),
    
            type:
              raw.series.type || null,
    
            leagueId:
              Number(raw.series.leagueId || 0),
    
            teamOneId:
              Number(raw.series.teamOneId || 0),
    
            teamTwoId:
              Number(raw.series.teamTwoId || 0),
    
            teamOne:
              canonicalTeam(
                raw.series.teamOne?.name,
              ),
    
            teamTwo:
              canonicalTeam(
                raw.series.teamTwo?.name,
              ),
    
            teamOneWinCount:
              Number(
                raw.series.teamOneWinCount || 0,
              ),
    
            teamTwoWinCount:
              Number(
                raw.series.teamTwoWinCount || 0,
              ),
    
            winningTeamId:
              raw.series.winningTeamId
                ? Number(
                    raw.series.winningTeamId,
                  )
                : null,
                    
            lastMatchDateTime:
              Number(
                raw.series.lastMatchDateTime || 0,
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
        .map(Number)
        .filter(
          (id) =>
            Number.isFinite(id) &&
            id > 0,
        ),
    ),
  ];

  if (!ids.length) {
    return [];
  }

  /*
   * Берём достаточно большой кусок истории
   * одним запросом.
   *
   * Важно: STRATZ раньше ограничивал take=5
   * на team.matches, поэтому оставляем 5.
   * Быстродействие получаем не за счёт take,
   * а за счёт отказа от пагинации/discovery.
   */
  const query = `{
    teams(teamIds: [${ids.join(",")}]) {
      id
      name

      matches(
        request: {
          take: 5
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
  /*
   * Больше НЕ делаем:
   * - discovery rounds;
   * - frontier;
   * - пагинацию;
   * - fetchTeamBatchHistory;
   *
   * Берём только известные нам команды.
   */
  const ids = [
    ...new Set(
      [
        ...SEED_TEAM_IDS,
        ...(knownIds || []),
      ]
        .map(Number)
        .filter(
          (id) =>
            Number.isFinite(id) &&
            id > 0,
        ),
    ),
  ];

  const byId =
    new Map();

  const discoveredIds =
    new Set(ids);

  /*
   * STRATZ нормально принимает несколько
   * teamIds, но не будем делать огромный
   * GraphQL на всякий случай.
   *
   * 5 команд на запрос.
   * При 18 ID это всего 4 запроса.
   */
  for (
    let offset = 0;
    offset < ids.length;
    offset += TEAM_BATCH_SIZE
  ) {
    const batch =
      ids.slice(
        offset,
        offset + TEAM_BATCH_SIZE,
      );

    if (!batch.length) {
      continue;
    }

    const teams =
      await fetchTeamsMatches(
        env,
        batch,
      );

    for (const team of teams) {
      const teamId =
        Number(team?.id || 0);

      if (teamId > 0) {
        discoveredIds.add(
          teamId,
        );
      }

      for (
        const raw
        of team?.matches || []
      ) {
        /*
         * Соперников запоминаем для информации,
         * но НЕ запускаем по ним новый discovery.
         */
        const radiantId =
          Number(
            raw.radiantTeamId ||
              raw.radiantTeam?.id ||
              0,
          );

        const direId =
          Number(
            raw.direTeamId ||
              raw.direTeam?.id ||
              0,
          );

        if (radiantId > 0) {
          discoveredIds.add(
            radiantId,
          );
        }

        if (direId > 0) {
          discoveredIds.add(
            direId,
          );
        }

        if (
          Number(raw.leagueId) !==
          LEAGUE_ID
        ) {
          continue;
        }

        const game =
          parseStratzMatch(
            raw,
          );

        if (!game) {
          continue;
        }

        byId.set(
          Number(game.matchId),
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
      ) || SEED_TEAM_IDS;

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
    /*
     * Telegram может повторно
     * прислать один и тот же update,
     * если Worker долго отвечает.
     *
     * Запоминаем update_id ДО
     * обращения к STRATZ.
     */
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
      /*
       * На /status не заставляем
       * пользователя ждать STRATZ.
       * Показываем уже сохранённое
       * состояние.
       */
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

          `⚠️ Пока нет сохранённых матчей TI 2026.\nПоследняя ошибка:\n<code>${escapeHtml(error)}</code>`,

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
        text === "/matches" ||
        text === "🎮 Результаты серий" ||
        text === "🎮 Последние матчи"
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

    /*
     * DEBUG:
     * показывает реальные canonical
     * названия всех команд,
     * присутствующих в сохранённых
     * картах.
     */
    if (
      text === "/teams"
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
      text === "/check" ||
      text === "🔄 Проверить сейчас"
    ) {
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
      ).toFixed(1);

      const games =
        await this.getGames();

      await sendTelegram(
        this.env,

        chatId,

        result.error
          ? `⚠️ Проверка закончилась с ошибкой:\n<code>${escapeHtml(result.error)}</code>`

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
