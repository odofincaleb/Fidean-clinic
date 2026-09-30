module.exports = {
  apps: [{
    name: 'fidean-clinic-saas',
    // The app runs from TypeScript source via tsx.
    // NOTE: `npm run build` is `tsc --noEmit` (type-check only) — it does NOT
    // emit dist/. Running ./dist/server.js would crash-loop. Do not point here.
    script: 'node_modules/.bin/tsx',
    args: 'src/server.ts',
    cwd: __dirname,
    interpreter: 'none',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    env: {
      HOST: '0.0.0.0',
      PORT: '4310',
      NODE_ENV: 'production',
    },
  }],
};
