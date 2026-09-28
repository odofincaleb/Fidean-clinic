module.exports = {
  apps: [{
    name: 'fidean-clinic-saas',
    script: './dist/server.js',
    env: {
      HOST: '0.0.0.0',
    },
  }],
};