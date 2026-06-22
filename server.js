const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();  // Load .env file (written by deploy script)

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
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
const SYSTEM_PROMPT = `You are the CEM888 Build Concierge — a live AI assistant embedded in the Agent Builder workspace. You help users build, configure, and deploy sovereign AI agents.

YOUR JOB: Answer questions about building agents — model selection, memory configuration, tool choices, plugins, integrations, API routing, voice setup, and deployment. You see the user's current builder state with every message (in [Builder State: ...] prefix).

AGENT BUILDER KNOWLEDGE:
- Agent Types: "worker" (tools + integrations, basic memory) or "intelligence" (full tree memory, ChromaDB, mirror daemon, persistent context)
- Primary Model: The main model for all queries. Can be any provider model (qwen3.7-max, claude-opus-4-8, gemini-2.5-pro, deepseek-chat, etc.)
- Compression Model: Optional lighter model for memory compression (qwen3.5-flash, gemini-2.5-flash, etc.)
- Fallback Model: Kicks in if primary fails (deepseek-chat, etc.)
- Memory: 5-layer tree memory — Observational, Semantic, Session persistence. Context window configurable.
- Voice: Kokoro TTS with 40+ voices (af_bella, am_adam, bf_emma, etc.)
- Tools: 14 built-in tools (web_search, web_extract, terminal, read_file, write_file, memory, session_search, send_message, text_to_speech, vision, browser, patch, delegate_task, cronjob)
- Plugins: Installable from Community — Social Media Scheduler, Auto Code Reviewer, Memory Archivist, Voice Cloner, Data Visualizer, Email Assistant, File Organizer, Web Scraper Pro
- Integrations: 23 platforms (GitHub, Gmail, Discord, Telegram, X/Twitter, YouTube, Slack, Notion, Spotify, Airtable, Linear, Supabase, Matrix, Stripe, Browser, Google Drive, Obsidian, WhatsApp, Apple Notes, and more). Each adds its tools automatically.
- API Routing: Route specific triggers to specialist models (e.g. "UI design" → claude-opus-4-8, "math" → deepseek-reasoner)
- Deploy: Generates a bash script that creates a Hermes profile with all settings, downloads dependencies, and starts the gateway.

DEPLOY COMMANDS (for users who ask):
- Mac: Open Terminal (⌘Space → Terminal) and paste the deploy script
- Windows: Open PowerShell (Win+R → powershell) and paste the deploy script
- The agent runs locally — nothing leaves the user's machine

RULES:
- Read the [Builder State] prefix to understand what the user is working on. Reference it in your answers.
- Be concise. Answer the question directly, then offer next steps.
- If the user asks about a specific model, tool, plugin, or integration — explain what it does and when to use it.
- For model recommendations: Worker agents do fine with fast models (qwen3.7-max, deepseek-chat). Intelligence cores benefit from larger context models (claude-opus-4-8, gemini-2.5-pro).
- Never guess model names or pricing. If unsure, suggest the user check the provider's current docs.
- If something is outside build scope (billing, account), direct to Dashboard or Profile.
- For deployment issues, suggest checking the terminal output and looking for error messages.

TONE: Direct, knowledgeable, concise. Like a senior engineer pairing with a colleague. No corporate speak, no emoji spam.`;

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
