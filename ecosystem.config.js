// PM2 Ecosystem — CEM Concierge
// Deploy: pm2 start ecosystem.config.js
// Save:   pm2 save

module.exports = {
  apps: [{
    name: 'cem-concierge',
    script: 'server.js',
    cwd: '[DEPLOY_PATH]',
    interpreter: 'node',
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: '4247',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      CORS_ORIGIN: 'https://[REDACTED_DOMAIN]',
      RATE_LIMIT_PER_MINUTE: '10'
    }
  }]
};
