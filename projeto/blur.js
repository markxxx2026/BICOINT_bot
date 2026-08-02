const path = require('path');
const fs = require('fs');
const { Jimp } = require('jimp');

const BLURRED_DIR = path.join(__dirname, 'painel', 'blurred');

async function blurBuffer(buffer) {
  const img = await Jimp.read(buffer);
  if (img.bitmap.width > 640) {
    img.resize({ w: 640 });
  }
  img.blur(10);
  return await img.getBuffer('image/jpeg');
}

function blurredPathFor(photo) {
  return path.join(BLURRED_DIR, photo.replace(/\.[^.]+$/, '') + '.jpg');
}

async function ensureBlurred(photo) {
  fs.mkdirSync(BLURRED_DIR, { recursive: true });
  const dest = blurredPathFor(photo);
  if (fs.existsSync(dest)) return dest;
  const src = path.join(__dirname, 'painel', 'faces', photo);
  if (!fs.existsSync(src)) return null;
  const out = await blurBuffer(fs.readFileSync(src));
  fs.writeFileSync(dest, out);
  return dest;
}

function deleteBlurred(photo) {
  const dest = blurredPathFor(photo);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
}

module.exports = { blurBuffer, ensureBlurred, deleteBlurred, blurredPathFor };
