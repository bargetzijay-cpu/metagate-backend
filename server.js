require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = 3000;

// ===== CONFIG =====
const TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || process.env.ADMIN_CHAT_ID;
// ===== TELEGRAM BOT =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== MIDDLEWARE =====
app.use(cors());
app.use(bodyParser.json());

// ===== MEMORY STORE (simple, volontairement) =====
const messagesByVisitor = {}; 
// structure:
// {
//   visitor_id: {
//     inbox: [ { text, from } ],
//     outbox: [ { text } ]
//   }
// }

// ===== RECEIVE MESSAGE FROM WIDGET =====
app.post('/message', (req, res) => {
  const { visitor_id, message } = req.body;
  if (!visitor_id || !message) {
    return res.json({ ok: false });
  }

  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  messagesByVisitor[visitor_id].inbox.push({
    text: message,
    from: 'visitor'
  });

  // send to telegram
  bot.sendMessage(
    TELEGRAM_CHAT_ID,
    `🧿 MetaGate\nVisitor: ${visitor_id}\n\n${message}`
  );

  res.json({ ok: true });
});

// ===== POLL REPLIES FOR WIDGET =====
app.get('/poll', (req, res) => {
  const { visitor_id } = req.query;
  if (!visitor_id || !messagesByVisitor[visitor_id]) {
    return res.json({ ok: true, replies: [] });
  }

  const replies = messagesByVisitor[visitor_id].outbox;
  messagesByVisitor[visitor_id].outbox = [];

  res.json({ ok: true, replies });
});

// ===== RECEIVE TELEGRAM REPLY =====
bot.on('message', msg => {
  if (!msg.text) return;

  const match = msg.text.match(/^@([a-zA-Z0-9\-]+)\s+(.+)/);
  if (!match) return;

  const visitor_id = match[1];
  const replyText = match[2];

  if (!messagesByVisitor[visitor_id]) {
    messagesByVisitor[visitor_id] = { inbox: [], outbox: [] };
  }

  messagesByVisitor[visitor_id].outbox.push({
    text: replyText
  });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`MetaGate server running on port ${PORT}`);
});
