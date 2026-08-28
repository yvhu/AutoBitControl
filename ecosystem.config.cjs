module.exports = {
  apps: [
    {
      name: 'autobitcontrol',
      script: 'node_modules/tsx/dist/cli.mjs',
      interpreter: 'node',
      args: 'src/index.ts',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
  ],
}
