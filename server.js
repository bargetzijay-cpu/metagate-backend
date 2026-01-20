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
const TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || process.env.ADMIN_CHAT_ID;

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

    res.json({ ok: true, url });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ ok: false });
  }
});

// ===== POLL (RETOUR VERS LE WIDGET) =====
app.get("/poll", (req, res) => {
  const { visitor_id } = req.query;
  if (!visitor_id || !messagesByVisitor[visitor_id]) {
    return res.json({ ok: true, replies: [] });
  }

  const replies = messagesByVisitor[visitor_id].outbox;
  messagesByVisitor[visitor_id].outbox = [];

  res.json({ ok: true, replies });
});

// ===== TELEGRAM -> TEXTE / PHOTO -> CLIENT =====
bot.on("message", async (msg) => {
  let visitor_id = null;

  // 🔹 si reply à un message MetaGate
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const m = msg.reply_to_message.text.match(/Visitor:\s*([a-zA-Z0-9\-]+)/);
    if (m) visitor_id = m[1];
  }

  // 🔹 fallback @visitorid
  if (!visitor_id && msg.text) {
    const m = msg.text.match(/^@([a-zA-Z0-9\-]+)\s+([\s\S]+)/);
    if (m) visitor_id = m[1];
  }

  if (!visitor_id) return;

  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  // TEXTE
  if (msg.text && !msg.photo) {
    const text = msg.text.replace(/^@[a-zA-Z0-9\-]+\s+/, "");
    messagesByVisitor[visitor_id].outbox.push({
      type: "text",
      text,
    });
  }

  // PHOTO
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    const url = await bot.getFileLink(best.file_id);

    messagesByVisitor[visitor_id].outbox.push({
      type: "image",
      url,
    });
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
