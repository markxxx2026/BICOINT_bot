require('dotenv').config();
const https = require('https');

const BASE_URL = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3';
const API_KEY = process.env.ASAAS_API_KEY;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      url,
      {
        method,
        headers: {
          access_token: API_KEY,
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
            const detail = json && json.errors
              ? json.errors.map((er) => er.description).join('; ')
              : (json && json.message) || raw || `HTTP ${res.statusCode}`;
            const err = new Error(detail);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout na requisição à API Asaas')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getOrCreateCustomer(chatId) {
  const ref = `chat_${chatId}`;
  const cpfCnpj = process.env.ASAAS_CUSTOMER_CPF;
  const list = await request('GET', `/customers?externalReference=${encodeURIComponent(ref)}&limit=1`);
  if (list && list.data && list.data.length) {
    const customer = list.data[0];
    if (cpfCnpj && !customer.cpfCnpj) {
      await request('PUT', `/customers/${customer.id}`, { cpfCnpj });
    }
    return customer.id;
  }
  const created = await request('POST', '/customers', {
    name: `Cliente chat ${chatId}`,
    cpfCnpj,
    externalReference: ref
  });
  return created.id;
}

async function createPixPayment({ chatId, value, externalReference, description }) {
  const customer = await getOrCreateCustomer(chatId);
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const payment = await request('POST', '/payments', {
    customer,
    billingType: 'PIX',
    value: Number(value),
    dueDate,
    description: String(description || 'Compra').slice(0, 200),
    externalReference: String(externalReference || '').slice(0, 100)
  });
  return payment;
}

async function getPixQrCode(paymentId) {
  return request('GET', `/payments/${paymentId}/pixQrCode`);
}

async function getPaymentStatus(paymentId) {
  const r = await request('GET', `/payments/${paymentId}/status`);
  return r.status;
}

module.exports = { createPixPayment, getPixQrCode, getPaymentStatus, getOrCreateCustomer, request };
