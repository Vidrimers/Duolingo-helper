import { Bot } from "grammy";
import { createServer } from "http";
import { randomBytes } from "crypto";
import { config } from "./config.js";
import db from "./db.js";

const bot = new Bot(config.tgBotToken);

// /start
bot.command("start", (ctx) => {
  const startPayload = ctx.match;
  if (startPayload) {
    // deep link с кодом линковки
    handleLinkCode(ctx, startPayload);
    return;
  }
  ctx.reply(
    "🦉 Duolingo Helper Bot\n\n" +
    "Команды:\n" +
    "/start — это сообщение\n" +
    "/help — справка\n\n" +
    "Для привязки аккаунта используй кнопку в скрипте Duolingo Helper."
  );
});

// /help
bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Доступные команды:\n\n" +
    "/start — приветствие / линковка аккаунта\n" +
    "/help — эта справка\n" +
    "/status — статус привязки\n" +
    "/unlink — отвязать аккаунт\n\n" +
    "Админ-команды:\n" +
    "/admin — панель администратора"
  );
});

// /status
bot.command("status", (ctx) => {
  const tgId = ctx.from.id;
  const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(tgId);
  if (!user) {
    ctx.reply("❌ Аккаунт не привязан. Используй кнопку в скрипте Duolingo Helper.");
    return;
  }
  ctx.reply(
    `✅ Аккаунт привязан:\n\n` +
    `Duolingo: ${user.duolingo_username || user.duolingo_user_id}\n` +
    `ID: ${user.duolingo_user_id}\n` +
    `Привязан: ${user.linked_at}`
  );
});

// /unlink
bot.command("unlink", async (ctx) => {
  const tgId = ctx.from.id;
  const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(tgId);
  if (!user) {
    ctx.reply("❌ Аккаунт не привязан.");
    return;
  }
  // TODO: подтверждение через inline-кнопки
  db.prepare("DELETE FROM users WHERE tg_user_id = ?").run(tgId);
  db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(user.duolingo_user_id);
  ctx.reply("✅ Аккаунт отвязан. Бэкапы удалены.");
});

// /admin — только для ADMIN_TG_ID
bot.command("admin", (ctx) => {
  if (ctx.from.id !== config.adminTgId) {
    ctx.reply("⛔ Нет доступа.");
    return;
  }
  const userCount = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  const backupCount = db.prepare("SELECT COUNT(*) as n FROM backups").get().n;
  const codeCount = db.prepare("SELECT COUNT(*) as n FROM link_codes WHERE used = 0 AND expires_at > ?").get(Date.now()).n;
  ctx.reply(
    `🔧 Админ-панель\n\n` +
    `Пользователей: ${userCount}\n` +
    `Бэкапов: ${backupCount}\n` +
    `Активных кодов: ${codeCount}`
  );
});

// обработка кода линковки из deep link
function handleLinkCode(ctx, code) {
  const row = db.prepare("SELECT * FROM link_codes WHERE code = ?").get(code);
  if (!row) {
    ctx.reply("❌ Код не найден.");
    return;
  }
  if (row.used) {
    ctx.reply("❌ Код уже использован.");
    return;
  }
  if (Date.now() > row.expires_at) {
    ctx.reply("❌ Код истёк. Получи новый в скрипте.");
    return;
  }
  if (row.attempts >= 5) {
    ctx.reply("❌ Слишком много попыток.");
    return;
  }

  db.prepare("UPDATE link_codes SET used = 1 WHERE code = ?").run(code);

  const existing = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
  if (existing && existing.duolingo_user_id !== row.duolingo_user_id) {
    ctx.reply(
      "⚠️ Уже привязан другой Duolingo-аккаунт.\n" +
      "Сначала отвяжи: /unlink"
    );
    return;
  }

  db.prepare(`
    INSERT INTO users (duolingo_user_id, tg_user_id, tg_username)
    VALUES (?, ?, ?)
    ON CONFLICT(tg_user_id) DO UPDATE SET
      duolingo_user_id = excluded.duolingo_user_id,
      tg_username = excluded.tg_username,
      linked_at = datetime('now')
  `).run(row.duolingo_user_id, ctx.from.id, ctx.from.username || "");

  ctx.reply(
    "✅ Аккаунт привязан!\n\n" +
    `Duolingo ID: ${row.duolingo_user_id}\n` +
    "Теперь ты получишь доступ к командам бота."
  );
}

// rate limiting
const rateLimitMap = new Map();

// HTTP API для скрипта (генерация кодов линковки)
const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/link-code") {
    // rate limiting: 5 запросов в минуту с одного IP
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const requests = rateLimitMap.get(ip).filter((t) => now - t < 60000);
    if (requests.length >= 5) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limit" }));
      return;
    }
    requests.push(now);
    rateLimitMap.set(ip, requests);

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { duolingoUserId, duolingoUsername } = JSON.parse(body || "{}");
        if (!duolingoUserId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId required" }));
          return;
        }

        // генерируем код
        const code = randomBytes(8).toString("hex");
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 минут

        // сохраняем в БД
        db.prepare(`
          INSERT INTO link_codes (code, duolingo_user_id, expires_at)
          VALUES (?, ?, ?)
        `).run(code, String(duolingoUserId), expiresAt);

        // TODO: сохранить username если передан

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code,
          deepLink: `https://t.me/Duolingo_Helperbot?start=${code}`,
          expiresAt,
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/link-status")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const duoId = url.searchParams.get("duolingoUserId");
    if (!duoId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "duolingoUserId required" }));
      return;
    }
    const user = db.prepare("SELECT tg_username, tg_user_id, linked_at FROM users WHERE duolingo_user_id = ?").get(String(duoId));
    if (user) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ linked: true, tgUsername: user.tg_username, linkedAt: user.linked_at }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ linked: false }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const HTTP_PORT = config.httpPort;

// запуск
bot.start({
  onStart: (me) => {
    console.log(`[bot] Started as @${me.username}`);
    console.log(`[bot] Admin: ${config.adminTgId}`);
    httpServer.listen(HTTP_PORT, () => {
      console.log(`[bot] HTTP API on port ${HTTP_PORT}`);
    });
  },
});
