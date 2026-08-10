/* ============================================================
   Sistema de indicação
   - registerReferral: registra que "referred" entrou pelo link de "referrer"
   - creditReferralForRefill: quando o indicado deposita (refill pago),
     credita R$ 10 na carteira do indicador e marca a indicação como paga.
   Usado tanto pelo bot (polling) quanto pelo painel (webhook de pagamento).
   ============================================================ */

const db = require('./database/db');

const REFERRAL_REWARD = Number(process.env.REFERRAL_REWARD || 10);

// Registra a indicação quando alguém entra pelo link /start ref_<id>.
// Ignora auto-indicação e indicado já atribuído a outro indicador.
function registerReferral(referrerChatId, referredChatId, cb) {
  if (!referrerChatId || !referredChatId) return cb && cb();
  if (Number(referrerChatId) === Number(referredChatId)) return cb && cb();
  db.get('SELECT chat_id FROM bot_users WHERE chat_id = ?', [referrerChatId], (err, referrer) => {
    if (err || !referrer) return cb && cb();
    db.run(
      `INSERT OR IGNORE INTO referrals (referrer_chat_id, referred_chat_id, reward, status)
       VALUES (?, ?, ?, 'pendente')`,
      [referrerChatId, referredChatId, REFERRAL_REWARD],
      (err2) => cb && cb(err2)
    );
  });
}

// Chamado sempre que um refill do indicado for confirmado (depósito pago).
// Idempotente: só paga uma vez por indicação (status pendente -> pago).
function creditReferralForRefill(referredChatId, cb) {
  if (!referredChatId) return cb && cb();
  db.get(
    "SELECT * FROM referrals WHERE referred_chat_id = ? AND status = 'pendente'",
    [referredChatId],
    (err, ref) => {
      if (err || !ref) return cb && cb();
      db.run(
        "UPDATE referrals SET status = 'pago', paid_at = datetime('now','localtime') WHERE id = ? AND status = 'pendente'",
        [ref.id],
        function (err2) {
          if (err2) return cb && cb(err2);
          if (this.changes === 0) return cb && cb();
          db.run(
            `INSERT INTO balances (chat_id, credits, updated_at)
             VALUES (?, ?, datetime('now','localtime'))
             ON CONFLICT(chat_id) DO UPDATE SET
               credits = credits + excluded.credits,
               updated_at = datetime('now','localtime')`,
            [ref.referrer_chat_id, ref.reward],
            (err3) => cb && cb(err3)
          );
        }
      );
    }
  );
}

// Estatísticas do indicador: pendentes, pagos e total ganho.
function countStats(chatId, cb) {
  db.get(
    `SELECT
       (SELECT COUNT(*) FROM referrals WHERE referrer_chat_id = ? AND status = 'pendente') AS pendentes,
       (SELECT COUNT(*) FROM referrals WHERE referrer_chat_id = ? AND status = 'pago') AS pagos,
       (SELECT COALESCE(SUM(reward), 0) FROM referrals WHERE referrer_chat_id = ? AND status = 'pago') AS ganho`,
    [chatId, chatId, chatId],
    (err, row) => cb && cb(err, row)
  );
}

module.exports = { registerReferral, creditReferralForRefill, countStats, REFERRAL_REWARD };
