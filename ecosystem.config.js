// PM2 Ecosystem — CEM Concierge
// Deploy: pm2 start ecosystem.config.js
// Save:   pm2 save
// Placeholders __DEPLOY_ROOT__ and __CORS_ORIGIN__ are replaced by deploy.yml
// DEEPSEEK_API_KEY is loaded from .env file (written by deploy script)

module.exports = {
  apps: [{
    name: 'cem-concierge',
    script: 'server.js',
    cwd: '__DEPLOY_ROOT__/concierge',
    interpreter: 'node',
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: '4247',
      CORS_ORIGIN: '__CORS_ORIGIN__',
      RATE_LIMIT_PER_MINUTE: '10'
    }
  }]
};
