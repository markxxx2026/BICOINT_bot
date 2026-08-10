/* ============================================================
   Diagnóstico do Mercado Pago (PIX)
   ------------------------------------------------------------
   Rode com as credenciais no .env (MP_ACCESS_TOKEN e MP_PAYER_EMAIL):
     node projeto/diag-mp.js
   Passos:
     1. GET /v1/users/me        -> valida token, tipo de conta (TEST/PROD)
     2. GET /v1/payment_methods -> confirma se PIX está habilitado na conta
     3. POST /v1/payments       -> tenta criar UM PIX de R$ 0,01 (fica
        pendente, não cobra nada) e mostra a resposta COMPLETA da API,
        incluindo o erro exato caso seja rejeitado.
   ============================================================ */

require('dotenv').config();
const mp = require('./mp');

async function main() {
  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  const email = String(process.env.MP_PAYER_EMAIL || '').trim();
  console.log('=== Diagnóstico Mercado Pago ===');
  console.log('Token:', token ? token.slice(0, 9) + '... (' + token.length + ' chars)' : 'AUSENTE');
  console.log('Payer email:', email || 'AUSENTE');
  if (!token) {
    console.log('\nMP_ACCESS_TOKEN ausente. Adicione MP_ACCESS_TOKEN e MP_PAYER_EMAIL no .env e rode de novo.');
    process.exit(1);
  }

  // 1. Token + tipo de conta
  console.log('\n[1/3] GET /v1/users/me');
  try {
    const me = await mp.request('GET', '/v1/users/me');
    console.log('  OK. id=', me.id, '| site=', me.site_id, '| user_type=', me.user_type);
    console.log('  tags=', JSON.stringify(me.tags || []));
    const pop = (me.points_of_payment || []).map((p) => ({
      id: p.id,
      payment_types: p.payment_types,
      supported_payment_methods: p.supported_payment_methods
    }));
    console.log('  points_of_payment=', JSON.stringify(pop));
    const isTest = (me.tags || []).some((t) => /test/i.test(String(t)));
    if (isTest) console.log('  => ATENÇÃO: conta de TESTE. Pagamentos não são reais; verifique se o token é de PRODUÇÃO (APP_USR-...).');
  } catch (e) {
    console.log('  FALHOU statusCode=', e.statusCode);
    console.log('  RESPOSTA COMPLETA:', JSON.stringify(e.details));
    if (e.statusCode === 401) console.log('  => TOKEN INVÁLIDO OU REVOGADO. Gere um novo Access Token de produção.');
    if (e.statusCode === 403) console.log('  => TOKEN SEM PERMISSÃO (scope).');
    process.exit(1);
  }

  // 2. Métodos de pagamento
  console.log('\n[2/3] GET /v1/payment_methods');
  try {
    const pm = await mp.request('GET', '/v1/payment_methods');
    const pix = (pm || []).find((p) => p.id === 'pix');
    console.log('  total métodos:', (pm || []).length);
    if (pix) {
      console.log('  pix DISPONÍVEL:', JSON.stringify({ status: pix.status, payment_type_id: pix.payment_type_id, secure_thumbnail: !!pix.secure_thumbnail }));
    } else {
      console.log('  pix NÃO está na lista => PIX não habilitado/ativado para esta conta. Cadastre a chave PIX no Mercado Pago.');
    }
  } catch (e) {
    console.log('  FALHOU statusCode=', e.statusCode, JSON.stringify(e.details));
  }

  // 3. Criar um PIX de R$ 0,01 (pendente, não cobra)
  console.log('\n[3/3] POST /v1/payments (PIX R$ 0,01 — fica pendente, não cobra)');
  try {
    const p = await mp.createPixPayment({
      chatId: 'diag',
      value: 0.01,
      externalReference: 'diag_mp_' + Date.now(),
      description: 'Teste de diagnostico do bot'
    });
    console.log('  OK! payment id=', p.id, '| status=', p.status);
    const qr = await mp.getPixQrCode(p.id);
    console.log('  qr_code=', qr.payload ? 'SIM (' + qr.payload.length + ' chars)' : 'NÃO');
    console.log('  qr_code_base64=', qr.encodedImage ? 'SIM (' + qr.encodedImage.length + ' chars)' : 'NÃO');
    console.log('  => PIX FUNCIONANDO. O problema do bot está no fluxo de status/webhook, não na geração do QR.');
  } catch (e) {
    console.log('  FALHOU statusCode=', e.statusCode);
    console.log('  MENSAGEM:', e.message);
    console.log('  RESPOSTA COMPLETA DA API:', JSON.stringify(e.details, null, 2));
    const d = e.details || {};
    if (d.cause && d.cause.length) console.log('  CAUSAS:', JSON.stringify(d.cause, null, 2));
    if (e.statusCode === 400) console.log('  => PAYLOAD rejeitado. Comparar o corpo enviado (acima) com o exigido pela API.');
    if (e.statusCode === 401) console.log('  => TOKEN inválido (ACCESS_TOKEN errado/revogado).');
    if (e.statusCode === 403) console.log('  => PERMISSÃO/scope do token ou conta sem PIX ativo.');
    if (e.statusCode === 404) console.log('  => Recurso não encontrado (token de ambiente errado).');
    process.exit(1);
  }
}

main();
