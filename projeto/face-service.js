const path = require('path');
const tf = require('@tensorflow/tfjs');
const wasm = require('@tensorflow/tfjs-backend-wasm');
const faceapi = require('@vladmandic/face-api');
const { Jimp } = require('jimp');

const MODELS_PATH = path.join(__dirname, 'models', 'face-api');
const THRESHOLD = 0.6;

let modelsLoaded = false;
let backendReady = false;

async function ensureModels() {
  if (!backendReady) {
    wasm.setThreadsCount(2);
    await tf.setBackend('wasm');
    await tf.ready();
    backendReady = true;
  }
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
  modelsLoaded = true;
}

async function bufferToTensor(buffer) {
  const img = await Jimp.read(buffer);
  const maxDim = Math.max(img.width, img.height);
  if (maxDim > 900) {
    img.scale(900 / maxDim);
  } else if (maxDim < 300) {
    img.scale(300 / maxDim);
  }
  const { data, width, height } = img.bitmap;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3]);
}

async function extractEmbedding(buffer, opts = {}) {
  await ensureModels();
  const tensor = await bufferToTensor(buffer);
  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: opts.inputSize || 320, scoreThreshold: 0.3 });
    let det = await faceapi
      .detectSingleFace(tensor, options)
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!det) {
      const all = await faceapi
        .detectAllFaces(tensor, options)
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (all && all.length) {
        all.sort((a, b) => b.detection.score - a.detection.score);
        det = all[0];
      }
    }
    if (!det) return null;
    return Array.from(det.descriptor);
  } finally {
    tensor.dispose();
  }
}

async function warmup() {
  await ensureModels();
  for (const inputSize of [224, 320]) {
    const t = tf.zeros([inputSize, inputSize, 3]);
    try {
      await faceapi.detectSingleFace(t, new faceapi.TinyFaceDetectorOptions({ inputSize })).withFaceLandmarks().withFaceDescriptor();
    } catch (e) {
      console.error('Warmup falhou:', e.message);
    } finally {
      t.dispose();
    }
  }
}

// Retorna os 68 landmarks do rosto mais confiante, no espaço da imagem.
async function getFaceLandmarks(buffer) {
  await ensureModels();
  const tensor = await bufferToTensor(buffer);
  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });
    let dets = await faceapi.detectAllFaces(tensor, options).withFaceLandmarks();
    if (!dets || !dets.length) return null;
    dets.sort((a, b) => b.detection.score - a.detection.score);
    const positions = dets[0].landmarks.positions;
    return positions.map((p) => ({ x: p.x, y: p.y }));
  } finally {
    tensor.dispose();
  }
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function findBestMatch(embedding, faces) {
  let best = null;
  let bestDistance = Infinity;
  for (const face of faces) {
    const stored = JSON.parse(face.embedding);
    const d = euclideanDistance(embedding, stored);
    if (d < bestDistance) {
      bestDistance = d;
      best = face;
    }
  }
  if (best && bestDistance <= THRESHOLD) {
    return { face: best, distance: bestDistance };
  }
  return null;
}

function findClosest(embedding, faces) {
  let best = null;
  let bestDistance = Infinity;
  for (const face of faces) {
    const stored = JSON.parse(face.embedding);
    const d = euclideanDistance(embedding, stored);
    if (d < bestDistance) {
      bestDistance = d;
      best = face;
    }
  }
  if (!best) return null;
  const similarity = Math.max(0, Math.min(100, Math.round((1 - bestDistance / 2) * 100)));
  return { face: best, distance: bestDistance, similarity };
}

module.exports = { extractEmbedding, findBestMatch, findClosest, euclideanDistance, THRESHOLD, warmup, getFaceLandmarks };
