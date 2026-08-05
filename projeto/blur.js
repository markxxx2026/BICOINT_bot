const { Jimp } = require('jimp');
const storage = require('./storage');

function blurredKeyFor(photo) {
  const stem = String(photo).replace(/\.[^.]+$/, '');
  return 'photos/blurred/' + stem + '.jpg';
}

async function blurBuffer(buffer) {
  const img = await Jimp.read(buffer);
  if (img.bitmap.width > 640) {
    img.resize({ w: 640 });
  }
  img.blur(10);
  return await img.getBuffer('image/jpeg');
}

// Retorna o Buffer borrado (do armazenamento). Se não existir, gera a partir
// da original, grava no armazenamento e devolve o Buffer — nunca perde nada.
async function getBlurredBuffer(photo) {
  const key = blurredKeyFor(photo);
  const cached = await storage.get(key);
  if (cached) return cached;
  const original = await storage.get('photos/' + photo);
  if (!original) return null;
  const out = await blurBuffer(original);
  await storage.put(key, out);
  return out;
}

// Garante que a versão borrada existe no armazenamento (usado no cadastro).
async function cacheBlurred(photo) {
  return getBlurredBuffer(photo);
}

async function deleteBlurred(photo) {
  await storage.remove(blurredKeyFor(photo));
}

module.exports = { blurBuffer, getBlurredBuffer, cacheBlurred, deleteBlurred, blurredKeyFor };
