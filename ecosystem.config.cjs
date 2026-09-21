module.exports = {
  apps: [{
    name: 'zylos-wsb', script: 'src/index.js', cwd: __dirname,
    instances: 1, exec_mode: 'fork', restart_delay: 3000, max_restarts: 5,
    kill_timeout: 40000
  }]
};
