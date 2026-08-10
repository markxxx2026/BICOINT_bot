/* ============================================================
   Entrada única de deploy (nuvem) — um processo só:
   painel + bot Telegram (via webhook).
   Uso local continua pelo start-all.js (polling).
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const storage = require('./storage');

async function main() {
  // Persistência local: garante as pastas de fotos antes de qualquer
  // módulo abrir o painel.db. Sem sincronização externa (R2/S3).
  await storage.boot();

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

  // Webhook do Mercado Pago: o MP faz POST aqui quando o PIX é pago.
  // A confirmação do pagamento já é feita pelo polling (a cada 5s); aqui
  // apenas reconhecemos a notificação (200) para o MP não reenviar.
  app.post('/webhook/mp', (req, res) => {
    const data = req.body || {};
    console.log('[mp] notificação recebida:', JSON.stringify({
      type: data.type,
      action: data.action,
      id: data.id,
      payment_id: data.data && data.data.id
    }).slice(0, 300));
    res.sendStatus(200);
  });

  async function registerWebhook() {
    console.log('Registrando webhook do Telegram ->', WEBHOOK_URL);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await bot.setWebHook(WEBHOOK_URL);
        console.log('Webhook configurado:', WEBHOOK_URL);
        return true;
      } catch (e) {
        // "EFATAL: AggregateError" vem da camada HTTP: conjunto de falhas de rede/DNS
        // ao falar com api.telegram.org. Desembrulha para logar a causa real.
        const detail = Array.isArray(e.errors) && e.errors.length
          ? e.errors.map((er) => er.message || er.code || String(er)).join(' | ')
          : (e.message || String(e));
        console.error(`Erro ao configurar webhook (tentativa ${attempt}/5): ${detail}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 10000));
      }
    }
    try {
      const info = await bot.getWebHookInfo();
      console.error('Não foi possível registrar o webhook após 5 tentativas. Estado atual no Telegram:', JSON.stringify(info));
      console.error('Se já havia um webhook registrado anteriormente, o bot continua recebendo updates normalmente.');
    } catch (e2) {
      console.error('Webhook não registrado após 5 tentativas e falhou ao consultar o estado (getWebHookInfo):', e2.message || e2);
    }
    return false;
  }

  if (WEBHOOK_URL) {
    await registerWebhook();
  } else {
    console.log('TELEGRAM_WEBHOOK_URL vazio — bot em modo polling.');
  }

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
}

main().catch((err) => {
  console.error('Erro fatal no boot:', err);
  process.exit(1);
});
