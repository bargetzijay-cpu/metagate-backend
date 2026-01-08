require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(cors());
app.use(express.json());

// ================== CONFIG ==================
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TOKEN || !ADMIN_CHAT_ID) {
  console.warn("⚠️ Missing env vars: BOT_TOKEN or ADMIN_CHAT_ID");
}

const bot = TOKEN ? new TelegramBot(TOKEN, { polling: true }) : null;

// ================== STORAGE (MVP) ==================
const inbox = {};
const outbox = {};
const lastFromBot = {};

function push(map, key, value) {
  if (!map[key]) map[key] = [];
  map[key].push(value);
}

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.send("Metagate backend is running");
});

// ================== SITE -> TELEGRAM ==================
app.post("/message", async (req, res) => {
  try {
    const { visitor_id, message } = req.body;
    if (!visitor_id || !message) {
      return res.status(400).json({ ok: false });
    }

    push(inbox, visitor_id, { t: Date.now(), text: message });

    if (!bot) {
      return res.status(500).json({ ok: false, error: "Bot not configured" });
    }

    const sent = await bot.sendMessage(
      ADMIN_CHAT_ID,
      `👤 ${visitor_id}\n${message}`
    );

    lastFromBot[sent.message_id] = visitor_id;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// ================== SITE <- TELEGRAM ==================
app.get("/poll", (req, res) => {
  const visitor_id = req.query.visitor_id;
  if (!visitor_id) return res.status(400).json({ ok: false });

  const replies = outbox[visitor_id] || [];
  outbox[visitor_id] = [];
  res.json({ ok: true, replies });
});

// ================== TELEGRAM -> SITE ==================
if (bot) {
  bot.on("message", (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    if (!msg.text) return;

    // Reply direct
    if (msg.reply_to_message) {
      const repliedId = msg.reply_to_message.message_id;
      let visitor_id = lastFromBot[repliedId];

      if (!visitor_id && msg.reply_to_message.text) {
        const firstLine = msg.reply_to_message.text.split("\n")[0].trim();
        visitor_id = firstLine.startsWith("👤")
          ? firstLine.replace("👤", "").trim()
          : firstLine;
      }

      if (visitor_id && visitor_id.length >= 8) {
        push(outbox, visitor_id, {
          t: Date.now(),
          text: msg.text.trim(),
        });
        console.log("✅ reply routed to", visitor_id);
        return;
      }
    }

    // Fallback manuel
    const lines = msg.text.split("\n");
    if (lines[0].startsWith("👤")) {
      const visitor_id = lines[0].replace("👤", "").trim();
      const reply = lines.slice(1).join("\n").trim();
      if (!visitor_id || !reply) return;

      push(outbox, visitor_id, { t: Date.now(), text: reply });
      console.log("✅ manual header routed to", visitor_id);
    }
  });
}

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`MetaGate live on http://localhost:${PORT}`);
});
