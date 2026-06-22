const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "https://cem888.ai" }));
app.use(express.json({ limit: "16kb" }));

// ━━━━━ CONFIG (all from env, never hardcoded) ━━━━━
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const PORT = parseInt(process.env.PORT || "4247");
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10");
const MAX_HISTORY = 20;

if (!DEEPSEEK_KEY) {
  console.error("FATAL: DEEPSEEK_API_KEY env var required");
  process.exit(1);
}

// ━━━━━ SYSTEM PROMPT ━━━━━
const SYSTEM_PROMPT = `You are the CEM888 Concierge — a helpful, direct AI assistant embedded in the CEM888.AI workspace.

YOUR JOB: Help users download, install, and configure their CEM888 sovereign AI agent. You guide them through the Agent Builder, troubleshoot setup issues, and explain how the platform works.

RULES:
- Be concise. No fluff.
- Give exact commands and file paths when relevant.
- If you don't know something, say so — never guess.
- Direct users to the Dashboard for billing, Profile for settings, Community for plugins.
- The workspace has 4 tabs: Overview, Agent Builder, Workflows, Knowledge Base.
- Downloads are handled through the Agent Builder tab.
- For complex issues, suggest they open a ticket or post in Community Forums.

TONE: Warm but professional. Like a senior engineer helping a colleague. No corporate speak.`;

// ━━━━━ RATE LIMITER (per-IP, sliding window) ━━━━━
const rateMap = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const window = 60000;
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > window) {
    rateMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, e] of rateMap) { if (e.windowStart < cutoff) rateMap.delete(ip); }
}, 300000);

// ━━━━━ SESSION STORE (in-memory, lost on restart — fine for concierge) ━━━━━
const sessions = new Map();
function getSession(sid) {
  if (!sessions.has(sid)) sessions.set(sid, []);
  return sessions.get(sid);
}
setInterval(() => {
  const cutoff = Date.now() - 3600000; // 1hr TTL
  for (const [sid, msgs] of sessions) {
    if (msgs.length && msgs[msgs.length - 1].time < cutoff) sessions.delete(sid);
  }
}, 900000);

// ━━━━━ HEALTH CHECK ━━━━━
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "cem-concierge", version: "1.0.0" });
});

// ━━━━━ CONCIERGE CHAT ━━━━━
app.post("/api/concierge/chat", async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Slow down — I'm one concierge, not an army." });
  }

  const { message, session_id } = req.body || {};
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "Message too long. Keep it under 2,000 characters." });
  }

  const sid = session_id || crypto.randomUUID();
  const history = getSession(sid);
  history.push({ role: "user", content: message.trim(), time: Date.now() });

  // Build messages array
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const recentMsgs = history.slice(-MAX_HISTORY);
  for (const m of recentMsgs) {
    messages.push({ role: "user", content: m.content });
    if (m.reply) messages.push({ role: "assistant", content: m.reply });
  }

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + DEEPSEEK_KEY
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: messages,
        max_tokens: 800,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[DEEPSEEK ERROR]", response.status, errText.substring(0, 200));
      return res.status(502).json({ error: "Concierge brain temporarily unavailable. Try again in a moment." });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Hmm, I drew a blank. Can you rephrase?";
    history[history.length - 1].reply = reply;

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - MAX_HISTORY * 2);
    }

    res.json({
      reply: reply,
      session_id: sid,
      model: "deepseek-chat"
    });

  } catch (err) {
    console.error("[CONCIERGE FATAL]", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Concierge encountered an internal error." });
    }
  }
});

app.listen(PORT, () => {
  console.log("CEM Concierge listening on port " + PORT);
  console.log("Model: deepseek-chat | Rate limit: " + RATE_LIMIT + "/min/IP | History: " + MAX_HISTORY + " msgs");
});
