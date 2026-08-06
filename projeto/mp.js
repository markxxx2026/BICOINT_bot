require('dotenv').config();
const https = require('https');

const BASE_URL = 'https://api.mercadopago.com';
const TOKEN = process.env.MP_ACCESS_TOKEN;

const qrCache = new Map();

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'BicoBot/1.0'
        },
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

async function createPixPayment({ chatId, value, externalReference, description }) {
  const body = {
    transaction_amount: Number(value),
    description: String(description || 'Compra').slice(0, 256),
    payment_method_id: 'pix',
    external_reference: String(externalReference || '').slice(0, 256),
    payer: { email: String(process.env.MP_PAYER_EMAIL || '') }
  };
  if (process.env.MP_NOTIFICATION_URL) {
    body.notification_url = process.env.MP_NOTIFICATION_URL;
  }
  const payment = await request('POST', '/v1/payments', body);
  const td = transactionDataFrom(payment);
  if (td && td.qr_code) qrCache.set(String(payment.id), td);
  return payment;
}

async function getPixQrCode(paymentId) {
  let td = qrCache.get(String(paymentId));
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

if (TOKEN) {
  console.log(`[mp] Mercado Pago PIX ativo (token=SIM, email=${process.env.MP_PAYER_EMAIL ? 'SIM' : 'NÃO'}).`);
} else {
  console.log('[mp] ATENCAO: MP_ACCESS_TOKEN ausente — pagamento PIX desativado.');
}
