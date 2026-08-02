const QRCode = require('qrcode');

function emv(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return `${id}${len}${v}`;
}

function crc16(buffer) {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function generateBrCode({ key, name, city, amount, txid }) {
  const merchantAccount =
    emv(26, emv(00, 'br.gov.bcb.pix') + emv(01, key));

  const additionalData = emv(62, emv(05, (txid || '***').toString().slice(0, 25)));

  const payload =
    emv(00, '01') +
    merchantAccount +
    emv(52, '0000') +
    emv(53, '986') +
    emv(54, Number(amount).toFixed(2)) +
    emv(58, 'BR') +
    emv(59, String(name || 'PIX').slice(0, 25)) +
    emv(60, String(city || 'BRASIL').slice(0, 15)) +
    additionalData;

  const withCrc = payload + '6304';
  return withCrc + crc16(Buffer.from(withCrc, 'utf8'));
}

async function renderPixQr(pixCode) {
  return QRCode.toBuffer(pixCode, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
}

module.exports = { generateBrCode, renderPixQr, crc16 };
