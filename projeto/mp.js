require('dotenv').config();
const https = require('https');

const BASE_URL = 'https://api.mercadopago.com';

const qrCache = new Map();
const QR_TTL_MS = 24 * 3600 * 1000;
const QR_MAX = 500;

function qrCacheSet(id, td) {
  qrCache.set(id, { ts: Date.now(), td });
  if (qrCache.size > QR_MAX) {
    qrCache.delete(qrCache.keys().next().value);
  }
}

// Lê o token a cada uso (não congela no carregamento do módulo), aceitando
// também configuração posterior do ambiente sem precisar reiniciar o bot.
function getAccessToken() {
  return String(process.env.MP_ACCESS_TOKEN || '').trim();
}

function request(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BicoBot/1.0'
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const req = https.request(
      url,
      {
        method,
        headers,
        timeout: 20000
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            /* ignore */
          }
          if (res.statusCode >= 400) {
            const detail = json && json.message
              ? json.message
              : (json && json.error) || raw || `HTTP ${res.statusCode}`;
            console.error(`[mp] ${method} ${path} -> ${res.statusCode}: ${detail}`);
            if (json) console.error('[mp] detalhes:', JSON.stringify(json).slice(0, 600));
            const err = new Error(detail);
            err.statusCode = res.statusCode;
            err.details = json;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout na requisição à API Mercado Pago')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function normalizeStatus(status) {
  switch (status) {
    case 'approved':
      return 'RECEIVED';
    case 'pending':
    case 'in_process':
    case 'authorized':
      return 'PENDENTE';
    case 'rejected':
      return 'REJEITADO';
    case 'cancelled':
      return 'CANCELADO';
    case 'refunded':
      return 'ESTORNADO';
    default:
      return status ? String(status).toUpperCase() : 'DESCONHECIDO';
  }
}

function transactionDataFrom(payment) {
  return (
    payment &&
    payment.point_of_interaction &&
    payment.point_of_interaction.transaction_data
  );
}

// URL de notificação do Mercado Pago — EXIGIDA pela API ("Ação obrigatória"
// na seção Pagamentos). Sem o campo notification_url o MP recusa a criação
// do PIX. Preferência: MP_NOTIFICATION_URL explícita; senão, deriva da base
// do TELEGRAM_WEBHOOK_URL (ex.: https://app.onrender.com/webhook/mp).
function notificationUrlFor() {
  const explicit = String(process.env.MP_NOTIFICATION_URL || '').trim();
  if (explicit) return explicit;
  const base = String(process.env.TELEGRAM_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
  const origin = base.replace(/\/webhook\/[^/]*$/, '');
  return origin ? origin + '/webhook/mp' : '';
}

async function createPixPayment({ chatId, value, externalReference, description }) {
  const body = {
    transaction_amount: Number(Number(value).toFixed(2)),
    description: String(description || 'Compra').slice(0, 256),
    payment_method_id: 'pix',
    external_reference: String(externalReference || '').slice(0, 256),
    payer: { email: String(process.env.MP_PAYER_EMAIL || '').trim() }
  };
  const notificationUrl = notificationUrlFor();
  if (notificationUrl) {
    body.notification_url = notificationUrl;
  } else {
    console.warn('[mp] ATENCAO: notification_url ausente (defina MP_NOTIFICATION_URL ou TELEGRAM_WEBHOOK_URL) — o Mercado Pago pode recusar o PIX.');
  }
  const payment = await request('POST', '/v1/payments', body, { 'X-Idempotency-Key': String(externalReference || `PIX_${Date.now()}`) });
  const td = transactionDataFrom(payment);
  if (td && td.qr_code) qrCacheSet(String(payment.id), td);
  return payment;
}

async function getPixQrCode(paymentId) {
  let td = null;
  const entry = qrCache.get(String(paymentId));
  if (entry && Date.now() - entry.ts < QR_TTL_MS) {
    td = entry.td;
  } else if (entry) {
    qrCache.delete(String(paymentId));
  }
  if (!td) {
    const p = await request('GET', `/v1/payments/${paymentId}`);
    td = transactionDataFrom(p);
  }
  const qrCode = (td && td.qr_code) || '';
  let encodedImage = (td && td.qr_code_base64) || '';
  if (encodedImage && !/^data:/i.test(encodedImage)) {
    encodedImage = 'data:image/png;base64,' + encodedImage;
  }
  return { encodedImage, payload: qrCode };
}

async function getPaymentStatus(paymentId) {
  const p = await request('GET', `/v1/payments/${paymentId}`);
  return normalizeStatus(p && p.status);
}

module.exports = { createPixPayment, getPixQrCode, getPaymentStatus, normalizeStatus, request };

if (getAccessToken()) {
  console.log(`[mp] Mercado Pago PIX ativo (token=SIM, email=${process.env.MP_PAYER_EMAIL ? 'SIM' : 'NÃO'}, notification_url=${notificationUrlFor() || 'NENHUMA'}).
[mp] IMPORTANTE: a API exige notification_url — sem ela o PIX pode ser recusado (Ação obrigatória).`);
} else {
  console.log('[mp] ATENCAO: MP_ACCESS_TOKEN ausente — pagamento PIX desativado.');
}
