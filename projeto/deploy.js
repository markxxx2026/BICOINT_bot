/* ============================================================
   Entrada única de deploy (nuvem) — um processo só:
   painel + bot Telegram (via webhook).
   Uso local continua pelo start-all.js (polling).
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = require('./painel/server');
const { bot } = require('./bot/index');

// Webhook: usa TELEGRAM_WEBHOOK_URL (ex.: https://seu-app.onrender.com/webhook/telegram).
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || '';
const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 3000);

// Webhook do Telegram (corpo JSON já vem parseado pelo express.json() do painel).
app.post('/webhook/telegram', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.error('Erro ao processar update do Telegram:', e.message);
  }
  res.sendStatus(200);
});

(async () => {
  if (WEBHOOK_URL) {
    try {
      await bot.setWebHook(WEBHOOK_URL);
      console.log('Webhook configurado:', WEBHOOK_URL);
    } catch (e) {
      console.error('Erro ao configurar webhook:', e.message);
    }
  } else {
    console.log('TELEGRAM_WEBHOOK_URL vazio — bot em modo polling.');
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de deploy rodando na porta ${PORT}`);
});

// Keepalive: o plano free da Render "dorme" após ~15 min sem requisições,
// fazendo o webhook do Telegram receber 502. Um ping no próprio serviço a
// cada 5 min conta como atividade e mantém a instância acordada 24/7.
const keepaliveHost = (WEBHOOK_URL || '').replace(/^https?:\/\//, '').split('/')[0];
if (keepaliveHost) {
  const keepaliveUrl = `https://${keepaliveHost}/login`;
  console.log(`Keepalive ativo -> ${keepaliveUrl} (a cada 5 min)`);
  setInterval(() => {
    fetch(keepaliveUrl, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, 5 * 60 * 1000);
} else {
  console.log('Keepalive desativado (sem TELEGRAM_WEBHOOK_URL para derivar a URL).');
}
