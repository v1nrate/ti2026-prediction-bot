import { DurableObject } from "cloudflare:workers";

const LEAGUE_ID = 19719;
const OPENDOTA = "https://api.opendota.com/api";

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
  "Team Vision": ["Team Vision", "TEAM VISION", "Vision", "PARIVISION", "PARI VISION"],
  "Team Yandex": ["Team Yandex", "Yandex", "Yandex Team"],
  "BoomBoys": ["BoomBoys", "BOOMBOYS", "BOOM Esports", "BOOM"],
  "Aurora Gaming": ["Aurora Gaming", "Aurora"],
  "Team Spirit": ["Team Spirit", "Spirit"],
  "Iron Wing": ["Iron Wing"],
  "Vici Gaming": ["Vici Gaming", "VG"],
  "Team Falcons": ["Team Falcons", "Falcons"],
  "LGD Gaming": ["LGD Gaming", "LGD"],
  "Nigma Galaxy": ["Nigma Galaxy", "Nigma"],
  "Xtreme Gaming": ["Xtreme Gaming", "XG"],
  "OG": ["OG"],
  "Team Liquid": ["Team Liquid", "Liquid"],
  "GamerLegion": ["GamerLegion", "Gamer Legion", "GL"],
  "HULIGANI": ["HULIGANI", "Huligani"],
  "Team Resilience": ["Team Resilience", "Resilience"],
};

const KIND_LABEL = {
  "4-0": "4-0",
  "4-1": "4-1",
  "elim_win": "ПРОХОДЯТ РАУНД НА ВЫБЫВАНИЕ",
  "elim_loss": "ВЫЛЕТАЮТ В РАУНДЕ НА ВЫБЫВАНИЕ",
  "1-4": "1-4",
  "0-4": "0-4",
};

const ORDER = ["4-0", "4-1", "elim_win", "elim_loss", "1-4", "0-4"];

const STATUS_ICON = {
  won: "✅",
  lost: "❌",
  waiting: "🟡",
  alive: "🟢",
};

const aliasMap = new Map();
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  for (const alias of aliases) aliasMap.set(normalizeName(alias), canonical);
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function canonicalTeam(value) {
  if (!value) return "Unknown";
  return aliasMap.get(normalizeName(value)) || String(value).trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
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

function fallbackSeriesKey(game) {
  const pair = [game.radiant, game.dire].sort().join("|");
  const bucket = game.startTime
    ? Math.floor(game.startTime / (6 * 3600))
    : game.matchId;
  return `fallback:${pair}:${bucket}`;
}

function buildSeries(games) {
  const grouped = new Map();

  for (const game of games) {
    const key = game.seriesId ? `series:${game.seriesId}` : fallbackSeriesKey(game);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(game);
  }

  const preliminary = [];

  for (const [key, rawItems] of grouped.entries()) {
    const items = [...rawItems].sort(
      (a, b) => a.startTime - b.startTime || a.matchId - b.matchId,
    );
    const teams = [...new Set(items.flatMap((x) => [x.radiant, x.dire]))].sort();
    if (teams.length !== 2) continue;

    const [a, b] = teams;
    const scoreA = items.filter((x) => x.winner === a).length;
    const scoreB = items.filter((x) => x.winner === b).length;

    // TI group-stage series are BO3. A completed series has a side on 2 wins.
    if (Math.max(scoreA, scoreB) < 2) continue;

    const winner = scoreA > scoreB ? a : b;
    const loser = winner === a ? b : a;

    preliminary.push({
      key,
      startTime: items[0].startTime,
      teamA: a,
      teamB: b,
      scoreA,
      scoreB,
      winner,
      loser,
    });
  }

  preliminary.sort(
    (a, b) => a.startTime - b.startTime || a.key.localeCompare(b.key),
  );

  // First pass only decides which completed series belong to Swiss vs elimination.
  const states = new Map();
  const results = [];

  const stateFor = (team) => {
    if (!states.has(team)) states.set(team, emptyTeamState(team));
    return states.get(team);
  };

  for (const s of preliminary) {
    const a = stateFor(s.teamA);
    const b = stateFor(s.teamB);

    const aReady =
      a.swissWins + a.swissLosses >= 5 &&
      ((a.swissWins === 3 && a.swissLosses === 2) ||
        (a.swissWins === 2 && a.swissLosses === 3));

    const bReady =
      b.swissWins + b.swissLosses >= 5 &&
      ((b.swissWins === 3 && b.swissLosses === 2) ||
        (b.swissWins === 2 && b.swissLosses === 3));

    const stage = aReady && bReady ? "elimination" : "swiss";
    results.push({ ...s, stage });

    if (stage === "swiss") {
      stateFor(s.winner).swissWins += 1;
      stateFor(s.loser).swissLosses += 1;
    } else {
      stateFor(s.winner).eliminationResult = "won";
      stateFor(s.loser).eliminationResult = "lost";
    }
  }

  return results;
}

function calculateStates(games) {
  const states = new Map();
  for (const p of PREDICTIONS) states.set(p.team, emptyTeamState(p.team));

  const stateFor = (team) => {
    if (!states.has(team)) states.set(team, emptyTeamState(team));
    return states.get(team);
  };

  const series = buildSeries(games);

  for (const s of series) {
    const a = stateFor(s.teamA);
    const b = stateFor(s.teamB);

    if (s.stage === "swiss") {
      stateFor(s.winner).swissWins += 1;
      stateFor(s.loser).swissLosses += 1;

      a.gameWins += s.scoreA;
      a.gameLosses += s.scoreB;
      b.gameWins += s.scoreB;
      b.gameLosses += s.scoreA;
    } else {
      stateFor(s.winner).eliminationResult = "won";
      stateFor(s.loser).eliminationResult = "lost";
    }
  }

  return { states, series };
}

function predictionStatus(kind, state) {
  const w = state.swissWins;
  const l = state.swissLosses;

  if (kind === "4-0") {
    if (w === 4 && l === 0) return ["won", "точно закончили групповой этап 4-0"];
    if (l > 0 || w >= 4)
      return ["lost", `текущий счёт серий ${w}-${l}; 4-0 уже невозможно`];
    return ["alive", `идут ${w}-${l}; для прогноза нужно закончить 4-0`];
  }

  if (kind === "4-1") {
    if (w === 4 && l === 1) return ["won", "точно закончили групповой этап 4-1"];
    if (l > 1 || (w >= 4 && l !== 1))
      return ["lost", `текущий счёт серий ${w}-${l}; точный 4-1 уже невозможен`];
    return ["alive", `идут ${w}-${l}; точный 4-1 ещё возможен`];
  }

  if (kind === "1-4") {
    if (w === 1 && l === 4) return ["won", "точно закончили групповой этап 1-4"];
    if (w > 1 || (l >= 4 && w !== 1))
      return ["lost", `текущий счёт серий ${w}-${l}; точный 1-4 уже невозможен`];
    return ["alive", `идут ${w}-${l}; точный 1-4 ещё возможен`];
  }

  if (kind === "0-4") {
    if (w === 0 && l === 4) return ["won", "точно закончили групповой этап 0-4"];
    if (w > 0 || l >= 4)
      return ["lost", `текущий счёт серий ${w}-${l}; 0-4 уже невозможно`];
    return ["alive", `идут ${w}-${l}; для прогноза нужно закончить 0-4`];
  }

  if (kind === "elim_win" || kind === "elim_loss") {
    const wanted = kind === "elim_win" ? "won" : "lost";

    if (state.eliminationResult !== null) {
      if (state.eliminationResult === wanted) {
        return [
          "won",
          wanted === "won"
            ? "выиграли раунд на выбывание — точное попадание"
            : "проиграли раунд на выбывание — точное попадание",
        ];
      }

      return [
        "lost",
        state.eliminationResult === "won"
          ? "выиграли раунд на выбывание — это противоположный исход"
          : "проиграли раунд на выбывание — это противоположный исход",
      ];
    }

    if (w >= 4)
      return [
        "lost",
        `закончили этап ${w}-${l} и прошли напрямую; раунда на выбывание для них не будет`,
      ];

    if (l >= 4)
      return [
        "lost",
        `закончили этап ${w}-${l} и вылетели напрямую; раунда на выбывание для них не будет`,
      ];

    if (
      w + l >= 5 &&
      ((w === 3 && l === 2) || (w === 2 && l === 3))
    ) {
      return [
        "waiting",
        `закончили этап ${w}-${l}; теперь должны ${
          wanted === "won" ? "выиграть" : "проиграть"
        } раунд на выбывание`,
      ];
    }

    return ["alive", `идут ${w}-${l}; пока могут попасть в раунд на выбывание`];
  }

  return ["alive", `идут ${w}-${l}`];
}

function makeSnapshot(games) {
  const { states } = calculateStates(games);
  const result = {};

  for (const p of PREDICTIONS) {
    const st = states.get(p.team) || emptyTeamState(p.team);
    const [status, reason] = predictionStatus(p.kind, st);
    result[p.team] = {
      kind: p.kind,
      swissWins: st.swissWins,
      swissLosses: st.swissLosses,
      eliminationResult: st.eliminationResult,
      status,
      reason,
    };
  }

  return result;
}

function predictionsText() {
  const lines = ["🏆 <b>ТВОИ ПРОГНОЗЫ — TI 2026</b>"];

  for (const kind of ORDER) {
    lines.push(`\n<b>${KIND_LABEL[kind]}</b>`);
    for (const p of PREDICTIONS) {
      if (p.kind === kind) lines.push(`• ${escapeHtml(p.team)}`);
    }
  }

  return lines.join("\n");
}

function statusText(games) {
  const { states, series } = calculateStates(games);
  const lines = [
    "🏆 <b>TI 2026 — состояние прогнозов</b>",
    `Сохранено карт: <b>${games.length}</b> · завершено серий: <b>${series.length}</b>`,
  ];

  for (const kind of ORDER) {
    lines.push(`\n<b>${KIND_LABEL[kind]}</b>`);

    for (const p of PREDICTIONS) {
      if (p.kind !== kind) continue;

      const st = states.get(p.team) || emptyTeamState(p.team);
      const [status, reason] = predictionStatus(kind, st);

      lines.push(
        `${STATUS_ICON[status]} <b>${escapeHtml(p.team)}</b> — ${st.swissWins}-${st.swissLosses}`,
      );
      lines.push(`   ${escapeHtml(reason)}`);
    }
  }

  return lines.join("\n");
}

function changesText(oldSnapshot, newSnapshot) {
  if (!oldSnapshot) return null;

  const lines = [];

  for (const p of PREDICTIONS) {
    const before = oldSnapshot[p.team];
    const after = newSnapshot[p.team];

    if (!before || !after) continue;

    const significant =
      before.status !== after.status ||
      before.swissWins !== after.swissWins ||
      before.swissLosses !== after.swissLosses ||
      before.eliminationResult !== after.eliminationResult;

    if (!significant) continue;

    lines.push(
      `${STATUS_ICON[after.status] || "ℹ️"} <b>${escapeHtml(p.team)}</b>: ` +
        `${before.swissWins}-${before.swissLosses} → ` +
        `${after.swissWins}-${after.swissLosses}\n` +
        `   ${escapeHtml(after.reason)}`,
    );
  }

  if (!lines.length) return null;
  return "🚨 <b>TI 2026 — прогнозы обновились</b>\n\n" + lines.join("\n\n");
}

function recentGamesText(games, limit = 10) {
  if (!games.length) return "Пока ни одной карты TI 2026 не сохранено.";

  const sorted = [...games]
    .sort((a, b) => b.startTime - a.startTime || b.matchId - a.matchId)
    .slice(0, limit);

  const lines = ["🎮 <b>Последние карты TI 2026</b>"];

  for (const g of sorted) {
    const duration = g.duration
      ? `${Math.floor(g.duration / 60)}:${String(g.duration % 60).padStart(2, "0")}`
      : "?";

    lines.push(
      `\n${g.radiantWin ? "✅" : "❌"} ${escapeHtml(g.radiant)}\n` +
        `${g.radiantWin ? "❌" : "✅"} ${escapeHtml(g.dire)}\n` +
        `${duration} · match ${g.matchId}`,
    );
  }

  return lines.join("\n");
}

function telegramKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 Статус" }, { text: "🎯 Мои прогнозы" }],
      [{ text: "🎮 Последние матчи" }, { text: "🔄 Проверить сейчас" }],
    ],
    resize_keyboard: true,
  };
}

async function telegramCall(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendTelegram(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramCall(env, "sendMessage", body);
}

function parseGame(raw) {
  try {
    const radiant = canonicalTeam(
      raw.radiant_name || raw.radiant_team?.name,
    );
    const dire = canonicalTeam(raw.dire_name || raw.dire_team?.name);

    if (!raw.match_id || radiant === "Unknown" || dire === "Unknown") return null;

    return {
      matchId: Number(raw.match_id),
      seriesId: raw.series_id ? Number(raw.series_id) : null,
      startTime: Number(raw.start_time || 0),
      duration: Number(raw.duration || 0),
      radiant,
      dire,
      radiantWin: Boolean(raw.radiant_win),
      winner: raw.radiant_win ? radiant : dire,
      leagueId: Number(raw.leagueid || raw.league_id || LEAGUE_ID),
      leagueName: String(raw.league_name || raw.league || ""),
    };
  } catch {
    return null;
  }
}

function looksLikeTI2026(name) {
  const n = String(name || "").toLowerCase().trim();

  return (
    n.includes("the international 2026") &&
    !n.includes("qualifier") &&
    !n.includes("qualification") &&
    !n.includes("regional")
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "TI2026PredictionBot/3.0",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function fetchCurrentTIGames() {
  const byId = new Map();

  // OpenDota's dedicated league endpoint is useful when available,
  // but it occasionally returns an error, so it is never our only source.
  try {
    const league = await fetchJson(`${OPENDOTA}/leagues/${LEAGUE_ID}/matches`);
    if (Array.isArray(league)) {
      for (const raw of league) {
        const game = parseGame(raw);
        if (game) byId.set(game.matchId, game);
      }
    }
  } catch (error) {
    console.log("League endpoint unavailable:", String(error));
  }

  const proMatches = await fetchJson(`${OPENDOTA}/proMatches`);
  if (!Array.isArray(proMatches)) throw new Error("OpenDota /proMatches returned non-array");

  for (const raw of proMatches) {
    const lid = Number(raw.leagueid || raw.league_id || -1);
    if (lid === LEAGUE_ID || looksLikeTI2026(raw.league_name)) {
      const game = parseGame(raw);
      if (game) byId.set(game.matchId, game);
    }
  }

  return [...byId.values()].sort(
    (a, b) => a.startTime - b.startTime || a.matchId - b.matchId,
  );
}

export class BotState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getOwnerId() {
    const configured = String(this.env.ADMIN_USER_ID || "").trim();
    if (configured) return Number(configured);
    return (await this.ctx.storage.get("ownerId")) ?? null;
  }

  async claimOwner(userId) {
    const configured = String(this.env.ADMIN_USER_ID || "").trim();
    if (configured) return Number(configured) === Number(userId);

    const existing = await this.ctx.storage.get("ownerId");
    if (existing == null) {
      await this.ctx.storage.put("ownerId", Number(userId));
      return true;
    }

    return Number(existing) === Number(userId);
  }

  async getGames() {
    return (await this.ctx.storage.get("games")) || [];
  }

  async sync(notify = false) {
    const existing = await this.getGames();
    const incoming = await fetchCurrentTIGames();

    const byId = new Map(existing.map((g) => [Number(g.matchId), g]));
    for (const g of incoming) byId.set(Number(g.matchId), g);

    const games = [...byId.values()].sort(
      (a, b) => a.startTime - b.startTime || a.matchId - b.matchId,
    );

    const oldSnapshot = await this.ctx.storage.get("snapshot");
    const newSnapshot = makeSnapshot(games);

    await this.ctx.storage.put("games", games);
    await this.ctx.storage.put("snapshot", newSnapshot);
    await this.ctx.storage.put("lastSync", Date.now());
    await this.ctx.storage.delete("lastError");

    const changes = changesText(oldSnapshot, newSnapshot);
    const ownerId = await this.getOwnerId();

    if (notify && changes && ownerId) {
      await sendTelegram(this.env, ownerId, changes, telegramKeyboard());
    }

    return {
      leagueId: LEAGUE_ID,
      games: games.length,
      newGames: Math.max(0, games.length - existing.length),
      changes: Boolean(changes),
    };
  }

  async safeSync(notify = false) {
    try {
      return await this.sync(notify);
    } catch (error) {
      await this.ctx.storage.put("lastError", String(error));
      console.error(error);
      return {
        leagueId: LEAGUE_ID,
        games: (await this.getGames()).length,
        newGames: 0,
        changes: false,
        error: String(error),
      };
    }
  }

  async handleTelegram(update) {
    const message = update?.message;
    if (!message?.chat?.id || !message?.from?.id) return { ok: true };

    const chatId = Number(message.chat.id);
    const userId = Number(message.from.id);
    const text = String(message.text || "").trim();

    if (text === "/start") {
      const allowed = await this.claimOwner(userId);
      if (!allowed) return { ok: true };

      const sync = await this.safeSync(false);

      await sendTelegram(
        this.env,
        chatId,
        "🏆 <b>TI 2026 Prediction Bot</b>\n\n" +
          "Я слежу за твоими прогнозами на The International 2026.\n" +
          "Проверка турнира идёт автоматически каждые 5 минут.\n\n" +
          `Твой Telegram ID: <code>${userId}</code>\n` +
          `Сейчас сохранено карт: <b>${sync.games}</b>`,
        telegramKeyboard(),
      );
      return { ok: true };
    }

    const ownerId = await this.getOwnerId();
    if (!ownerId || Number(ownerId) !== userId) return { ok: true };

    if (text === "/predictions" || text === "🎯 Мои прогнозы") {
      await sendTelegram(this.env, chatId, predictionsText(), telegramKeyboard());
      return { ok: true };
    }

    if (text === "/status" || text === "📊 Статус") {
      await this.safeSync(false);
      const games = await this.getGames();

      if (!games.length) {
        const error = (await this.ctx.storage.get("lastError")) || "матчи пока не получены";
        await sendTelegram(
          this.env,
          chatId,
          `⚠️ Не удалось получить матчи TI 2026:\n<code>${escapeHtml(error)}</code>`,
          telegramKeyboard(),
        );
      } else {
        await sendTelegram(this.env, chatId, statusText(games), telegramKeyboard());
      }
      return { ok: true };
    }

    if (text === "/matches" || text === "🎮 Последние матчи") {
      await this.safeSync(false);
      const games = await this.getGames();
      await sendTelegram(this.env, chatId, recentGamesText(games), telegramKeyboard());
      return { ok: true };
    }

    if (text === "/check" || text === "🔄 Проверить сейчас") {
      await sendTelegram(this.env, chatId, "🔄 Проверяю TI 2026…", telegramKeyboard());

      const result = await this.safeSync(true);
      const games = await this.getGames();

      await sendTelegram(
        this.env,
        chatId,
        result.error
          ? `⚠️ Проверка закончилась с ошибкой:\n<code>${escapeHtml(result.error)}</code>`
          : `✅ Готово.\nLeague ID: <code>${LEAGUE_ID}</code>\n` +
              `Карт сохранено: <b>${result.games}</b>\n` +
              `Новых карт: <b>${result.newGames}</b>`,
        telegramKeyboard(),
      );

      if (games.length) {
        await sendTelegram(this.env, chatId, statusText(games), telegramKeyboard());
      }
      return { ok: true };
    }

    await sendTelegram(
      this.env,
      chatId,
      "Используй кнопки снизу или команды:\n/status\n/predictions\n/matches\n/check",
      telegramKeyboard(),
    );
    return { ok: true };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      return jsonResponse(await this.handleTelegram(await request.json()));
    }

    if (url.pathname === "/sync") {
      return jsonResponse(
        await this.safeSync(url.searchParams.get("notify") === "1"),
      );
    }

    if (url.pathname === "/health") {
      const games = await this.getGames();
      return jsonResponse({
        ok: true,
        leagueId: LEAGUE_ID,
        games: games.length,
        ownerId: await this.getOwnerId(),
        lastSync: (await this.ctx.storage.get("lastSync")) || null,
        lastError: (await this.ctx.storage.get("lastError")) || null,
      });
    }

    return textResponse("Not found", 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const state = env.BOT_STATE.getByName("ti2026");

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return state.fetch(
        new Request("https://state.internal/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        }),
      );
    }

    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) {
        return jsonResponse({ ok: false, error: "BOT_TOKEN secret is missing" }, 500);
      }

      const webhookUrl = `${url.origin}/telegram/webhook`;
      const result = await telegramCall(env, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      });

      return jsonResponse({
        ok: true,
        webhook: webhookUrl,
        telegram: result,
        next: "Open Telegram and send /start to the bot",
      });
    }

    if (url.pathname === "/health") {
      return state.fetch("https://state.internal/health");
    }

    if (url.pathname === "/check") {
      return state.fetch("https://state.internal/sync?notify=1");
    }

    return textResponse(
      "TI 2026 Prediction Bot is running.\n" +
        "Open /setup once after adding BOT_TOKEN.\n" +
        "Open /health to see status.\n",
    );
  },

  async scheduled(controller, env, ctx) {
    const state = env.BOT_STATE.getByName("ti2026");
    ctx.waitUntil(state.fetch("https://state.internal/sync?notify=1"));
  },
};
