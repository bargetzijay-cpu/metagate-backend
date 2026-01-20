require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");

const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.ADMIN_CHAT_ID;

// ===== CLOUDINARY =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(bodyParser.json());

// multer memory (pas de fichiers sur disque)
const upload = multer({ storage: multer.memoryStorage() });

// ===== TELEGRAM BOT (WEBHOOK) =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
const WEBHOOK_PATH = `/telegram/${TELEGRAM_TOKEN}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== MEMORY STORE =====
const messagesByVisitor = {};

// ===== LONG-POLL STATE =====
const pendingPollByVisitor = {}; // visitor_id -> { res, timer }

// helper: push reply and instantly wake pending poll if exists
function pushReply(visitor_id, reply) {
  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  messagesByVisitor[visitor_id].outbox.push(reply);

  const pending = pendingPollByVisitor[visitor_id];
  if (pending && pending.res) {
    try { clearTimeout(pending.timer); } catch (e) {}

    const replies = messagesByVisitor[visitor_id].outbox;
    messagesByVisitor[visitor_id].outbox = [];
    delete pendingPollByVisitor[visitor_id];

    try {
      return pending.res.json({ ok: true, replies });
    } catch (e) {
      // if response already closed, ignore
    }
  }
}

// ===== CLIENT -> TEXTE -> TELEGRAM =====
app.post("/message", (req, res) => {
  const { visitor_id, message } = req.body;
  if (!visitor_id || !message) return res.json({ ok: false });

  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  messagesByVisitor[visitor_id].inbox.push({
    type: "text",
    text: message,
    from: "visitor",
  });

  // send to telegram
  bot.sendMessage(
    TELEGRAM_CHAT_ID,
    `🧿 MetaGate\nVisitor: ${visitor_id}\n\n${message}`
  );

  res.json({ ok: true });
});

// ===== CLIENT -> PHOTO -> TELEGRAM =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const visitor_id = req.body.visitor_id;
    const file = req.file;
    if (!visitor_id || !file) return res.status(400).json({ ok: false });

    if (!messagesByVisitor[visitor_id]) {
      messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
    }

    // upload cloudinary
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "metagate_chat" },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(file.buffer);
    });

    const url = uploaded.secure_url;

    // envoyer à Telegram
    await bot.sendPhoto(TELEGRAM_CHAT_ID, url, {
      caption: `🧿 MetaGate Photo\nVisitor: ${visitor_id}`,
    });

    // (optionnel) si tu veux aussi afficher au client la vraie URL (ton front le fait déjà)
    res.json({ ok: true, url });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ ok: false });
  }
});

// ===== POLL (LONG-POLL, INSTANT, SAFE) =====
app.get("/poll", (req, res) => {
  const { visitor_id } = req.query;
  if (!visitor_id) return res.json({ ok: true, replies: [] });

  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  // If we already have replies, return immediately
  const existing = messagesByVisitor[visitor_id].outbox;
  if (existing.length) {
    messagesByVisitor[visitor_id].outbox = [];
    return res.json({ ok: true, replies: existing });
  }

  // If another poll is already waiting, close it (avoid duplicates)
  if (pendingPollByVisitor[visitor_id] && pendingPollByVisitor[visitor_id].res) {
    try { pendingPollByVisitor[visitor_id].res.json({ ok: true, replies: [] }); } catch (e) {}
    try { clearTimeout(pendingPollByVisitor[visitor_id].timer); } catch (e) {}
  }

  // Hold this request up to 25s
  const timer = setTimeout(() => {
    if (pendingPollByVisitor[visitor_id] && pendingPollByVisitor[visitor_id].res === res) {
      delete pendingPollByVisitor[visitor_id];
    }
    res.json({ ok: true, replies: [] });
  }, 25000);

  pendingPollByVisitor[visitor_id] = { res, timer };

  req.on("close", () => {
    const p = pendingPollByVisitor[visitor_id];
    if (p && p.res === res) {
      try { clearTimeout(p.timer); } catch (e) {}
      delete pendingPollByVisitor[visitor_id];
    }
  });
});

// ===== TELEGRAM -> TEXTE / PHOTO -> CLIENT =====
bot.on("message", async (msg) => {
  let visitor_id = null;

  // 1) si reply à un message MetaGate
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const m = msg.reply_to_message.text.match(/Visitor:\s*([a-zA-Z0-9\-]+)/);
    if (m) visitor_id = m[1];
  }

  // 2) fallback: @visitorid
  let replyText = msg.text || "";
  if (!visitor_id && msg.text) {
    const m = msg.text.match(/^@([a-zA-Z0-9\-]+)\s+([\s\S]+)/);
    if (m) {
      visitor_id = m[1];
      replyText = m[2];
    }
  }

  if (!visitor_id) return;

  // TEXTE
  if (msg.text && !msg.photo) {
    // si c'était un reply normal, on garde le texte tel quel
    // si c'était @visitorid message, replyText contient déjà la bonne partie
    pushReply(visitor_id, { type: "text", text: replyText });
  }

  // PHOTO (Telegram -> client)
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    const url = await bot.getFileLink(best.file_id);
    pushReply(visitor_id, { type: "image", url });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`✅ MetaGate server running on port ${PORT}`);

  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) {
    console.error("❌ RENDER_EXTERNAL_URL missing");
    return;
  }

  const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`;
  bot.setWebHook(webhookUrl).then(() => {
    console.log("✅ Telegram webhook set:", webhookUrl);
  });
});
