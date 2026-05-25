module.exports = {
  apps: [
    {
      name: 'steel-orchestrator',
      script: 'agent-core/scripts/steel-orchestrator.mjs',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'steel-bot',
      script: 'agent-core/src/telegram-bot.mjs',
      env: {
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? '',
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || ''
      }
    },
    {
      name: 'agent-tasks-daemon',
      script: 'agent-core/agent-tasks/bin/pos-daemon.mjs',
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000
    }
  ]
};
