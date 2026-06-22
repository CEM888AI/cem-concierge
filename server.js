const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();  // Load .env file (written by deploy script)

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "16kb" }));

// ━━━━━ CONFIG (all from env, never hardcoded) ━━━━━
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const PORT = parseInt(process.env.PORT || "4247");
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10");
const MAX_HISTORY = 20;
const CONFIG_STORE_PATH = process.env.CONFIG_STORE_PATH || path.join(__dirname, "agent_configs.json");

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

TONE: Direct, knowledgeable, concise. Like a senior engineer pairing with a colleague. No corporate speak, no emoji spam.

CONFIG PROGRAMMING: You have access to the agent's live configuration. Every message includes a [Config: {...}] block showing the current state. When the user asks to add/change something (model, plugin, integration, tool, voice, name, etc.), respond with EXACTLY this format on its own line to update the config:

[CONFIG: {"primaryModel": "claude-opus-4-8", "integrations": ["github", "slack"]}]

The system will parse this and update the stored config automatically. Only include fields the user wants to change. Explain what you changed in plain English after the CONFIG block.`;

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

// ━━━━━ AGENT CONFIG STORE (persistent JSON, keyed by session_id) ━━━━━
let configStore = {};
try {
  if (fs.existsSync(CONFIG_STORE_PATH)) {
    configStore = JSON.parse(fs.readFileSync(CONFIG_STORE_PATH, "utf-8"));
  }
} catch (e) { configStore = {}; }

function getConfig(sid) {
  if (!configStore[sid]) {
    configStore[sid] = {
      name: "",
      profileType: "worker",
      icon: "🤖",
      description: "",
      primaryModel: "",
      compressionModel: null,
      fallbackModel: null,
      contextWindow: "128K",
      memoryLayers: "5-layer tree",
      memObservational: true,
      memSemantic: false,
      memSession: true,
      voice: null,
      systemPrompt: "",
      tools: [],
      plugins: [],
      integrations: [],
      routes: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };
  }
  return configStore[sid];
}

function updateConfig(sid, changes) {
  const cfg = getConfig(sid);
  // Field aliases (what concierge might say → what we store)
  const ALIASES = { model: 'primaryModel', type: 'profileType', compModel: 'compressionModel', fallModel: 'fallbackModel', ctx: 'contextWindow' };
  const normalized = {};
  for (const [key, val] of Object.entries(changes)) {
    const target = ALIASES[key] || key;
    normalized[target] = val;
  }
  // Deep merge: arrays replace, strings/objects merge
  for (const [key, val] of Object.entries(normalized)) {
    if (key === "session_id" || key === "created") continue;
    if (Array.isArray(val)) {
      cfg[key] = val;
    } else if (val !== null && typeof val === "object") {
      cfg[key] = { ...cfg[key], ...val };
    } else {
      cfg[key] = val;
    }
  }
  cfg.updated = new Date().toISOString();
  configStore[sid] = cfg;
  // Persist to disk
  try {
    fs.writeFileSync(CONFIG_STORE_PATH, JSON.stringify(configStore, null, 2));
  } catch (e) { console.error("[CONFIG] Failed to persist:", e.message); }
  return cfg;
}

// Cleanup stale configs (same TTL as sessions)
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  let changed = false;
  for (const [sid, cfg] of Object.entries(configStore)) {
    if (cfg.updated && new Date(cfg.updated).getTime() < cutoff) {
      delete configStore[sid];
      changed = true;
    }
  }
  if (changed) {
    try { fs.writeFileSync(CONFIG_STORE_PATH, JSON.stringify(configStore, null, 2)); }
    catch (e) {}
  }
}, 900000);

// ━━━━━ CONFIG API ━━━━━
// GET — retrieve agent config (concierge reads this)
app.get("/api/concierge/config", (req, res) => {
  const sid = req.query.session_id;
  if (!sid) return res.status(400).json({ error: "session_id required" });
  res.json(getConfig(sid));
});

// POST — update agent config (UI + concierge write to this)
app.post("/api/concierge/config", (req, res) => {
  const { session_id, ...changes } = req.body || {};
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: "No fields to update" });
  const cfg = updateConfig(session_id, changes);
  res.json(cfg);
});

// POST — generate deploy script from stored config
app.post("/api/concierge/deploy", (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  const cfg = getConfig(session_id);
  if (!cfg.primaryModel) return res.status(400).json({ error: "Agent not configured yet. Set a primary model first." });
  const script = generateDeployScript(cfg);
  res.json({ script, agentName: cfg.name || "my-agent" });
});

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

  // Inject current config into the message context
  const cfg = getConfig(sid);
  const configBlock = "[Config: " + JSON.stringify({
    name: cfg.name, type: cfg.profileType, model: cfg.primaryModel,
    voice: cfg.voice || "none", compModel: cfg.compressionModel || "none",
    fallModel: cfg.fallbackModel || "none", ctx: cfg.contextWindow,
    plugins: cfg.plugins, integrations: cfg.integrations,
    tools: cfg.tools, routes: cfg.routes
  }) + "] ";
  history.push({ role: "user", content: configBlock + message.trim(), time: Date.now() });

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
    let reply = data.choices?.[0]?.message?.content || "Hmm, I drew a blank. Can you rephrase?";

    // Parse [CONFIG: {...}] blocks from concierge response
    const configMatch = reply.match(/\[CONFIG:\s*(\{.*?\})\]/s);
    let configChanges = null;
    if (configMatch) {
      try {
        configChanges = JSON.parse(configMatch[1]);
        updateConfig(sid, configChanges);
        // Remove the CONFIG block from the visible reply
        reply = reply.replace(configMatch[0], "").trim();
      } catch (e) { console.error("[CONFIG PARSE]", e.message); }
    }

    history[history.length - 1].reply = reply;

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - MAX_HISTORY * 2);
    }

    res.json({
      reply: reply,
      session_id: sid,
      model: "deepseek-chat",
      config: configChanges
    });

  } catch (err) {
    console.error("[CONCIERGE FATAL]", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Concierge encountered an internal error." });
    }
  }
});

// ━━━━━ DEPLOY SCRIPT GENERATOR ━━━━━
function generateDeployScript(cfg) {
  const name = cfg.name || "my-agent";
  const profileName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const isIntelligence = cfg.profileType === "intelligence";
  const primaryModel = cfg.primaryModel || "qwen3.7-max";
  const lines = [];
  lines.push("#!/bin/bash");
  lines.push("# ═══════════════════════════════════════════");
  lines.push("#  CEM888.AI Agent Deploy — \"" + name + "\"");
  lines.push("#  Powered by Hermes Agent (nousresearch.com)");
  lines.push("# ═══════════════════════════════════════════");
  lines.push("set -e");
  lines.push("");
  lines.push("echo \"🔷 CEM888.AI | Deploying agent: " + name + "\"");
  lines.push("");
  lines.push("# 1. Create Hermes profile");
  lines.push("hermes profile create " + profileName + " --clone");
  lines.push("");
  lines.push("PROFILE_DIR=\"$HOME/.hermes/profiles/" + profileName + "\"");
  lines.push("");
  lines.push("# 2. Configure model");
  lines.push("hermes -p " + profileName + " config set model.default \"" + primaryModel + "\"");
  if (cfg.compressionModel) {
    lines.push("hermes -p " + profileName + " config set aux.compression.model \"" + cfg.compressionModel + "\"");
  }
  if (cfg.fallbackModel) {
    lines.push("hermes -p " + profileName + " config set aux.fallback.model \"" + cfg.fallbackModel + "\"");
  }
  if (cfg.contextWindow) {
    const ctxTokens = (parseInt(cfg.contextWindow) * 1000) || 128000;
    lines.push("hermes -p " + profileName + " config set model.context_length " + ctxTokens);
  }
  if (cfg.voice) {
    lines.push("hermes -p " + profileName + " config set tts.voice \"" + cfg.voice + "\"");
  }
  if (cfg.systemPrompt) {
    lines.push("# System prompt → SOUL.md");
    lines.push("cat > \"$PROFILE_DIR/SOUL.md\" << 'SOUL_EOF'");
    lines.push(cfg.systemPrompt);
    lines.push("SOUL_EOF");
  }
  if (cfg.integrations && cfg.integrations.length > 0) {
    lines.push("");
    lines.push("# Connected integrations: " + cfg.integrations.join(", "));
    lines.push("# Add API keys in: $PROFILE_DIR/.env");
  }
  if (isIntelligence) {
    lines.push("");
    lines.push("# ═══════════ INTELLIGENCE CORE ═══════════");
    lines.push("echo \"🧠 Installing Intelligence Core...\"");
    lines.push("# Mirror daemon + ChromaDB + Shadow Logger + Vault");
    lines.push("cp -r /opt/cem888/mirror-daemon \"$PROFILE_DIR/scripts/mirror\" 2>/dev/null || echo '(mirror daemon not available — install manually)'");
    lines.push("cp -r /opt/cem888/chroma-ingest \"$PROFILE_DIR/scripts/chroma\" 2>/dev/null || echo '(chroma ingest not available)'");
    lines.push("cp -r /opt/cem888/shadow-logger \"$PROFILE_DIR/scripts/shadow\" 2>/dev/null || echo '(shadow logger not available)'");
    lines.push("mkdir -p \"$HOME/CEM-Vault-" + profileName + "\"");
    lines.push("echo \"✅ Intelligence Core scaffolded\"");
  }
  if (cfg.routes && cfg.routes.length > 0) {
    lines.push("");
    lines.push("# API routing:");
    cfg.routes.forEach(function (r) {
      lines.push("#   → " + r.model + " (trigger: " + r.trigger + ")");
    });
  }
  lines.push("");
  lines.push("# 3. Start gateway");
  lines.push("echo \"\"");
  lines.push("echo \"✅ Agent deployed! Starting gateway...\"");
  lines.push("hermes -p " + profileName + " gateway start");
  lines.push("");
  lines.push("echo \"\"");
  lines.push("echo \"╔══════════════════════════════════════╗\"");
  lines.push("echo \"║  🚀 " + name + " is now LIVE             ║\"");
  lines.push("echo \"║  Model: " + primaryModel + "\"");
  if (cfg.voice) lines.push("echo \"║  Voice: " + cfg.voice + "\"");
  lines.push("echo \"║  Profile: " + profileName + "\"");
  lines.push("echo \"║  Config: $PROFILE_DIR\"");
  lines.push("echo \"║\"");
  lines.push("echo \"║  💎 @concierge:cem888.ai linked\"");
  lines.push("echo \"║  Ask for help anytime in chat\"");
  lines.push("echo \"╚══════════════════════════════════════╝\"");
  return lines.join("\n");
}

app.listen(PORT, () => {
  console.log("CEM Concierge listening on port " + PORT);
  console.log("Model: deepseek-chat | Rate limit: " + RATE_LIMIT + "/min/IP | History: " + MAX_HISTORY + " msgs");
});
