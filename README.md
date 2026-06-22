# CEM Concierge

AI assistant embedded in the CEM888 workspace Agent Builder. Helps users download, install, and configure their sovereign AI agents.

## Architecture

```
User → Workspace Frontend → POST /api/concierge/chat → DeepSeek API → Response
```

- **Model**: DeepSeek Chat (fast, cheap, capable)
- **Runtime**: Node.js + Express
- **Deploy**: GitHub Actions → DigitalOcean Droplet → PM2

## Setup

### 1. Clone
```bash
git clone git@github.com:CEM888AI/cem-concierge.git
cd cem-concierge
```

### 2. Environment
```bash
cp .env.example .env
# Edit .env with your DeepSeek API key
```

### 3. Run locally
```bash
npm install
npm start
```

### 4. Deploy
Push to `main` — GitHub Actions handles the rest.

## API

### `POST /api/concierge/chat`

**Request:**
```json
{
  "message": "How do I download the CEM agent?",
  "session_id": "optional-session-uuid"
}
```

**Response:**
```json
{
  "reply": "Go to the Agent Builder tab...",
  "session_id": "abc-123",
  "model": "deepseek-chat"
}
```

### `GET /health`

Returns service status.

## Security

- All API keys via environment variables — never committed
- Rate limited: 10 requests/min per IP
- Message cap: 2,000 characters
- CORS restricted to cem888.ai
- Session history in-memory, auto-expires after 1hr

## Required Secrets (GitHub Actions)

| Secret | Purpose |
|--------|---------|
| `DROPLET_HOST` | DigitalOcean droplet IP |
| `DROPLET_SSH_KEY` | SSH private key for deployment |

## Required Env Vars (Droplet)

| Variable | Example |
|----------|---------|
| `DEEPSEEK_API_KEY` | `sk-...` (set on droplet, never in repo) |
| `PORT` | `4247` (default) |
| `CORS_ORIGIN` | `https://cem888.ai` |
| `RATE_LIMIT_PER_MINUTE` | `10` |
