/* ============================================================
   Entrada única de deploy (nuvem) — um processo só:
   painel + Mini App + bot Telegram (via webhook).
   Uso local continua pelo start-all.js (polling).
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = require('./painel/server');
const { bot } = require('./bot/index');

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
