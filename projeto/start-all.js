const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { spawn } = require('child_process');
const storage = require('./storage');

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const supervisorLog = fs.createWriteStream(path.join(LOG_DIR, 'supervisor.log'), { flags: 'a' });

const services = [
  { name: 'bot', cwd: path.join(__dirname, 'bot'), script: 'index.js' },
  { name: 'painel', cwd: path.join(__dirname, 'painel'), script: 'server.js' }
];

const children = new Map();

function log(name, line) {
  const stamp = new Date().toISOString();
  const out = `[${stamp}] [${name}] ${line}`;
  console.log(out);
  supervisorLog.write(out + '\n');
}

function start(service) {
  const file = fs.createWriteStream(path.join(LOG_DIR, `${service.name}.log`), { flags: 'a' });
  const child = spawn('node', [service.script], { cwd: service.cwd, env: process.env, windowsHide: true });

  child.stdout.on('data', (d) => { log(service.name, d.toString().trimEnd()); file.write(d); });
  child.stderr.on('data', (d) => { log(service.name, '[ERRO] ' + d.toString().trimEnd()); file.write(d); });

  child.on('exit', (code, signal) => {
    log(service.name, `Processo encerrado (code=${code}, signal=${signal}). Reiniciando em 3s...`);
    file.end();
    children.delete(service.name);
    setTimeout(() => start(service), 3000);
  });

  children.set(service.name, child);
  log(service.name, `Iniciado (pid=${child.pid}).`);
}

// Persistência local: garante as pastas de fotos antes dos processos abrirem o painel.db.
storage.boot().then(() => {
  services.forEach(start);
}).catch((err) => {
  console.error('Falha no boot de armazenamento:', err.message);
  services.forEach(start);
});

process.on('SIGINT', () => {
  console.log('Encerrando todos os serviços...');
  for (const [name, child] of children) child.kill();
  process.exit(0);
});
