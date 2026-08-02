/* ============================================================
   Fusão de rosto (face morph) — mistura duas fotos em um só
   rosto, alinhando os 68 landmarks via Delaunay + warp + blend.
   ============================================================ */

const { Jimp } = require('jimp');
const faceService = require('./face-service');

const OUT_SIZE = 600;      // tamanho do canvas de saída
const BLEND = 0.5;         // % de mistura (0.5 = 50/50)

function borderFor(w, h) {
  return [
    { x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 },
    { x: (w - 1) / 2, y: 0 }, { x: w - 1, y: (h - 1) / 2 }, { x: (w - 1) / 2, y: h - 1 }, { x: 0, y: (h - 1) / 2 },
  ];
}

// Triangulação de Delaunay (Bowyer–Watson). points: [{x,y}]
function delaunayTriangulation(points) {
  const n = points.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dmax = Math.max(maxX - minX, maxY - minY) * 2;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  points.push(
    { x: midX - dmax, y: midY - dmax },
    { x: midX + dmax, y: midY - dmax },
    { x: midX, y: midY + dmax },
  );
  const tris = [[n, n + 1, n + 2]];

  function circumcircle(i, j, k) {
    const ax = points[i].x, ay = points[i].y;
    const bx = points[j].x, by = points[j].y;
    const cx = points[k].x, cy = points[k].y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (d === 0) return { x: 0, y: 0, r2: Infinity };
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r2 = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
    return { x: ux, y: uy, r2 };
  }

  for (let i = 0; i < n; i++) {
    const pi = points[i];
    const bad = [];
    for (const t of tris) {
      const cc = circumcircle(t[0], t[1], t[2]);
      const dxp = pi.x - cc.x, dyp = pi.y - cc.y;
      if (dxp * dxp + dyp * dyp <= cc.r2) bad.push(t);
    }
    if (!bad.length) continue;

    const counts = new Map();
    const edgeList = [];
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        edgeList.push([a, b]);
      }
    }
    const boundary = [];
    const seen = new Set();
    for (const [a, b] of edgeList) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (counts.get(key) === 1 && !seen.has(key)) {
        seen.add(key);
        boundary.push([a, b]);
      }
    }

    const badSet = new Set(bad);
    for (let t = tris.length - 1; t >= 0; t--) {
      if (badSet.has(tris[t])) tris.splice(t, 1);
    }
    for (const [a, b] of boundary) tris.push([a, b, i]);
  }

  points.length = n;
  const result = [];
  for (const t of tris) {
    if (t[0] < n && t[1] < n && t[2] < n) result.push(t);
  }
  return result;
}

// Coordenadas baricêntricas de p no triângulo (a,b,c). p = w*a + u*b + v*c
function toBary(p, a, b, c) {
  const denom = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (denom === 0) return null;
  const u = ((p.x - a.x) * (c.y - a.y) - (p.y - a.y) * (c.x - a.x)) / denom;
  const v = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / denom;
  return [u, v, 1 - u - v];
}

// Amostragem bilinear de um canal (dado o array RGBA plano).
function sample(data, size, x, y) {
  let cx = x, cy = y;
  if (cx < 0) cx = 0; else if (cx > size - 1) cx = size - 1;
  if (cy < 0) cy = 0; else if (cy > size - 1) cy = size - 1;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
  const fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * size + x0) * 4;
  const i10 = (y0 * size + x1) * 4;
  const i01 = (y1 * size + x0) * 4;
  const i11 = (y1 * size + x1) * 4;
  const top = (c) => (data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy);
  const bot = (c) => (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
  return [top(0) + bot(0), top(1) + bot(1), top(2) + bot(2)];
}

// Fusão de rosto: 1ª foto (cliente) + 2ª foto (bico).
async function morphFaces(buf1, buf2) {
  const imgA = await Jimp.read(buf1);
  const imgB = await Jimp.read(buf2);

  imgA.resize({ w: OUT_SIZE, h: OUT_SIZE });
  imgB.resize({ w: OUT_SIZE, h: OUT_SIZE });

  const lm1 = await faceService.getFaceLandmarks(await imgA.getBuffer('image/png'));
  const lm2 = await faceService.getFaceLandmarks(await imgB.getBuffer('image/png'));
  if (!lm1 || !lm2) {
    throw new Error('Não consegui detectar um rosto em uma das fotos. Envie fotos com o rosto bem visível.');
  }
  if (lm1.length !== 68 || lm2.length !== 68) {
    throw new Error('Não consegui mapear todos os pontos do rosto. Tente fotos mais nítidas e de frente.');
  }

  const border = borderFor(OUT_SIZE, OUT_SIZE);
  const pts1 = lm1.concat(border);
  const pts2 = lm2.concat(border);
  const mid = pts1.map((p, i) => ({ x: (p.x + pts2[i].x) / 2, y: (p.y + pts2[i].y) / 2 }));

  const tris = delaunayTriangulation(mid.slice());

  const dataA = imgA.bitmap.data;
  const dataB = imgB.bitmap.data;
  const out = new Jimp({ width: OUT_SIZE, height: OUT_SIZE, color: 0x000000ff });
  const outData = out.bitmap.data;
  const size = OUT_SIZE;

  for (const [ai, bi, ci] of tris) {
    const a = mid[ai], b = mid[bi], c = mid[ci];
    const sa1 = pts1[ai], sb1 = pts1[bi], sc1 = pts1[ci];
    const sa2 = pts2[ai], sb2 = pts2[bi], sc2 = pts2[ci];

    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const bary = toBary({ x, y }, a, b, c);
        if (!bary) continue;
        const [u, v, w] = bary;
        if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;

        const sx1 = w * sa1.x + u * sb1.x + v * sc1.x;
        const sy1 = w * sa1.y + u * sb1.y + v * sc1.y;
        const sx2 = w * sa2.x + u * sb2.x + v * sc2.x;
        const sy2 = w * sa2.y + u * sb2.y + v * sc2.y;

        const p1 = sample(dataA, size, sx1, sy1);
        const p2 = sample(dataB, size, sx2, sy2);

        const idx = (y * size + x) * 4;
        outData[idx] = (p1[0] * (1 - BLEND) + p2[0] * BLEND) | 0;
        outData[idx + 1] = (p1[1] * (1 - BLEND) + p2[1] * BLEND) | 0;
        outData[idx + 2] = (p1[2] * (1 - BLEND) + p2[2] * BLEND) | 0;
        outData[idx + 3] = 255;
      }
    }
  }

  return out.getBuffer('image/jpeg');
}

// Mantida para referência: junção lado a lado (comparação).
async function mergeTwoPhotos(buf1, buf2) {
  const a = await Jimp.read(buf1);
  const b = await Jimp.read(buf2);

  const height = 720;
  const scale = (img) => img.scale(height / img.bitmap.height);
  const sa = scale(a);
  const sb = scale(b);

  const gap = 10;
  const width = sa.bitmap.width + sb.bitmap.width + gap * 3;
  const canvas = new Jimp({ width, height, color: 0x0b0b11ff });

  canvas.composite(sa, gap, 0);
  canvas.composite(sb, gap + sa.bitmap.width + gap, 0);

  return canvas.getBuffer('image/jpeg');
}

module.exports = { morphFaces, mergeTwoPhotos };
