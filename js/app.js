'use strict';

/* =====================================================================
 * 批量水印工具 主程序
 * 坐标约定：所有水印图层使用「相对坐标」——
 *   x / y：图层中心点相对于图片（宽/高）的比例 0~1
 *   尺寸：宽度、字号、线宽等均为相对于图片宽度的比例
 * 因此同一份水印模板应用到不同分辨率 / 比例的图片时，位置自动统一。
 * ===================================================================== */

/* ---------------- 工具函数 ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const readAsDataURL = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
const loadHtmlImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const canvasToBlob = (c, mime, q) => new Promise((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error('图片编码失败')), mime, q));

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

const SUPPORT_WEBP = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL('image/webp').indexOf('image/webp') === 5;
})();

const FONTS = [
  ['"Microsoft YaHei"', '微软雅黑'],
  ['"SimHei"', '黑体'],
  ['"SimSun"', '宋体'],
  ['"KaiTi"', '楷体'],
  ['"FangSong"', '仿宋'],
  ['Arial', 'Arial'],
  ['"Times New Roman"', 'Times New Roman'],
  ['Georgia', 'Georgia'],
  ['Verdana', 'Verdana'],
  ['"Courier New"', 'Courier New'],
  ['Impact', 'Impact'],
  ['"Comic Sans MS"', 'Comic Sans MS'],
];
const TYPE_LABEL = { text: '文字', image: 'Logo', line: '直线', arrow: '箭头', rect: '矩形', ellipse: '椭圆', doodle: '涂鸦' };

/* ---------------- 全局状态 ---------------- */
const state = {
  images: [],         // {id,file,name,bitmap(ImageBitmap),bw,bh,rotation,thumbUrl}
  current: -1,
  layers: [],
  selectedId: null,
  tool: 'select',
  drawColor: '#e61610',
  drawWidth: 0.005,
  zoom: 1,
  baseScale: 1,
  outDirHandle: null,
  history: [],
  histIndex: -1,
  gesture: null,      // 当前指针手势
  temp: null,         // 创建中的图层
  logoCache: new Map(),
};

/* =====================================================================
 * 图层工厂
 * ===================================================================== */
function makeTextLayer(x, y) {
  return {
    id: uid(), type: 'text', visible: true,
    x, y, rotation: 0, opacity: 1,
    text: '文字水印',
    font: '"Microsoft YaHei"',
    size: 0.072,
    bold: true, italic: false,
    color: '#e61610',
    spacing: 0,
    bg: false, bgColor: '#000000', bgPad: 0.12, bgRadius: 0.15, bgOpacity: 0.45,
    stroke: false, strokeColor: '#ffffff', strokeWidth: 0.08,
    shadow: false, shadowColor: '#000000', shadowBlur: 0.25, shadowDx: 0.08, shadowDy: 0.08, shadowOpacity: 0.6,
  };
}
function makeImageLayer(img, src) {
  return {
    id: uid(), type: 'image', visible: true,
    x: 0.5, y: 0.82, rotation: 0, opacity: 1,
    w: 0.27, aspect: img.width / img.height,
    src, _img: img,
  };
}
function makeShapeLayer(type, x, y, color, width) {
  return {
    id: uid(), type, visible: true,
    x, y, w: 0.001, h: 0.001, rotation: 0, opacity: 1,
    color, width,
    sx: 1, sy: 1,   // line / arrow 的终点方向（相对中心）
  };
}
function norm180(a) {
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}
function layerName(l) {
  if (l.type === 'text') return '文字：' + ((l.text || '').split('\n')[0].slice(0, 8) || '空');
  if (l.type === 'image') return 'Logo 图片';
  return TYPE_LABEL[l.type] || '图层';
}

/* =====================================================================
 * 历史记录（仅记录水印图层）
 * ===================================================================== */
function snapshot() {
  return JSON.stringify(state.layers, (k, v) => (k[0] === '_' ? undefined : v));
}
function pushHistory() {
  const s = snapshot();
  if (state.history[state.histIndex] === s) return;
  state.history = state.history.slice(0, state.histIndex + 1);
  state.history.push(s);
  if (state.history.length > 60) state.history.shift();
  state.histIndex = state.history.length - 1;
  updateUndoBtns();
}
function restoreSnapshot(s) {
  const layers = JSON.parse(s);
  for (const l of layers) {
    if (l.type === 'image' && state.logoCache.has(l.src)) l._img = state.logoCache.get(l.src);
  }
  state.layers = layers;
  if (!getSelected()) state.selectedId = null;
}
function undo() {
  if (state.histIndex <= 0) return;
  state.histIndex--;
  restoreSnapshot(state.history[state.histIndex]);
  renderAll();
  updateUndoBtns();
}
function redo() {
  if (state.histIndex >= state.history.length - 1) return;
  state.histIndex++;
  restoreSnapshot(state.history[state.histIndex]);
  renderAll();
  updateUndoBtns();
}
function updateUndoBtns() {
  $('#btnUndo').disabled = state.histIndex <= 0;
  $('#btnRedo').disabled = state.histIndex >= state.history.length - 1;
}

/* =====================================================================
 * 图片导入 / 缩略图 / 旋转
 * ===================================================================== */
const cur = () => state.images[state.current] || null;
const getSelected = () => state.layers.find((l) => l.id === state.selectedId) || null;

async function bitmapFromFile(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return await createImageBitmap(file); }
}

async function importFiles(fileList) {
  const files = Array.from(fileList).filter((f) =>
    /^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp|gif|avif|tiff?)$/i.test(f.name));
  if (!files.length) { toast('没有可导入的图片文件', 'err'); return; }
  let ok = 0;
  for (const f of files) {
    try {
      const bmp = await bitmapFromFile(f);
      const item = { id: uid(), file: f, name: f.name, bitmap: bmp, bw: bmp.width, bh: bmp.height, rotation: 0, thumbUrl: '' };
      makeThumb(item);
      state.images.push(item);
      ok++;
    } catch (err) {
      console.error('图片读取失败', f.name, err);
    }
  }
  if (ok) {
    if (state.current < 0) state.current = 0;
    $('#emptyState').classList.add('hidden');
    fitView();
    renderAll();
    toast(`已导入 ${ok} 张图片`, 'ok');
  } else {
    toast('图片导入失败，请检查文件格式', 'err');
  }
}

function makeThumb(item) {
  const swapped = item.rotation === 90 || item.rotation === 270;
  const w = swapped ? item.bh : item.bw;
  const h = swapped ? item.bw : item.bh;
  const s = Math.min(1, 160 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(item.rotation * Math.PI / 180);
  ctx.drawImage(item.bitmap, -item.bw * s / 2, -item.bh * s / 2, item.bw * s, item.bh * s);
  item.thumbUrl = c.toDataURL('image/jpeg', 0.72);
}

function rotateImage(item, delta) {
  if (!item) return;
  item.rotation = (item.rotation + delta + 360) % 360;
  makeThumb(item);
  fitView();
  renderAll();
}

function removeImage(id) {
  const idx = state.images.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const item = state.images[idx];
  item.bitmap.close && item.bitmap.close();
  state.images.splice(idx, 1);
  if (state.current >= state.images.length) state.current = state.images.length - 1;
  if (!state.images.length) $('#emptyState').classList.remove('hidden');
  fitView();
  renderAll();
}

/* =====================================================================
 * 视口与主渲染
 * ===================================================================== */
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

function orientedDims(item) {
  const swapped = item.rotation === 90 || item.rotation === 270;
  return { w: swapped ? item.bh : item.bw, h: swapped ? item.bw : item.bh };
}
function fitView() {
  state.zoom = 1;
  const item = cur();
  if (!item) { state.baseScale = 1; return; }
  const stage = $('#stage');
  const d = orientedDims(item);
  const aw = stage.clientWidth - 70, ah = stage.clientHeight - 70;
  state.baseScale = Math.min(aw / d.w, ah / d.h);
}
function viewDims() {
  const item = cur();
  if (!item) return null;
  const stage = $('#stage');
  const d = orientedDims(item);
  const s = state.baseScale * state.zoom;
  const W = d.w * s, H = d.h * s;
  return {
    W, H, s,
    S: Math.sqrt(W * H),   // 画面几何尺度（旋转不变、对宽高比不敏感），用于所有水印尺寸
    cx: stage.clientWidth / 2, cy: stage.clientHeight / 2,
  };
}
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const rw = Math.round(w * dpr), rh = Math.round(h * dpr);
  if (canvas.width !== rw || canvas.height !== rh) { canvas.width = rw; canvas.height = rh; }
  return dpr;
}

function render() {
  const dpr = resizeCanvas();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const item = cur();
  const v = viewDims();
  if (!item || !v) { updateStatus(); return; }

  /* 底图（在中心旋转） */
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(v.cx, v.cy);
  ctx.rotate(item.rotation * Math.PI / 180);
  ctx.drawImage(item.bitmap, -item.bw * v.s / 2, -item.bh * v.s / 2, item.bw * v.s, item.bh * v.s);
  ctx.restore();

  /* 图片边框 */
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(v.cx - v.W / 2 + 0.5, v.cy - v.H / 2 + 0.5, v.W - 1, v.H - 1);

  /* 水印图层（坐标空间为「旋转后的图片方向」） */
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.cx - v.W / 2, v.cy - v.H / 2, v.W, v.H);
  ctx.clip();
  const ox = v.cx - v.W / 2, oy = v.cy - v.H / 2;
  for (const l of state.layers) {
    if (l.visible) drawLayer(ctx, l, v.W, v.H, ox, oy);
  }
  if (state.temp) drawLayer(ctx, state.temp, v.W, v.H, ox, oy);
  ctx.restore();

  /* 选中框 */
  const sel = getSelected();
  if (sel && sel.visible && state.tool === 'select') drawSelection(ctx, sel, v);

  updateStatus(v);
}

/* =====================================================================
 * 图层绘制
 * W/H 为图片（定向后）显示尺寸，cx/cy 为图片中心
 * ===================================================================== */
function roundRectPath(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function textFont(l, sizePx) {
  return `${l.italic ? 'italic ' : ''}${l.bold ? '700 ' : ''}${sizePx}px ${l.font}, "Microsoft YaHei", sans-serif`;
}
function textMetrics(c, l, S) {
  const sizePx = l.size * S;
  c.font = textFont(l, sizePx);
  const sp = l.spacing * sizePx;
  const lines = (l.text || ' ').split('\n');
  const widths = lines.map((line) => {
    const chars = Array.from(line);
    let tw = 0;
    for (const ch of chars) tw += c.measureText(ch).width;
    return tw + sp * Math.max(0, chars.length - 1);
  });
  const lh = sizePx * 1.28;
  return { sizePx, sp, lines, widths, lh, maxW: Math.max(1, ...widths), blockH: lines.length * lh };
}

/* 图层中心（相对图片左上角 0~1）：
 * 未贴角 → 直接用存储的 x/y；
 * 贴角(pin) → 由「边角 + 边距」实时推算，边距按尺寸基准 S 计，
 * 因此在不同分辨率/宽高比的图片上都会自动对齐同一边角。 */
function layerCenter(l, W, H) {
  if (!l.pin) return { x: l.x, y: l.y };
  const S = Math.sqrt(W * H);
  const e = layerExtents(ctx, l, W, H);
  const offX = e.hw + (l.pin.mx || 0) * S;
  const offY = e.hh + (l.pin.my || 0) * S;
  return {
    x: l.pin.hx === -1 ? offX / W : l.pin.hx === 1 ? 1 - offX / W : l.x,
    y: l.pin.hy === -1 ? offY / H : l.pin.hy === 1 ? 1 - offY / H : l.y,
  };
}

/* 图层中心在屏幕上的位置 */
function layerScreenPos(l, v) {
  const ctr = layerCenter(l, v.W, v.H);
  return {
    x: v.cx - v.W / 2 + ctr.x * v.W,
    y: v.cy - v.H / 2 + ctr.y * v.H,
  };
}
/* cx/cy 为图片左上角原点（预览传 (cx-W/2, cy-H/2)，导出传 (0,0)） */
function drawLayer(c, l, W, H, ox, oy) {
  c.save();
  c.globalAlpha = l.opacity == null ? 1 : l.opacity;
  const ctr = layerCenter(l, W, H);
  c.translate(ox + ctr.x * W, oy + ctr.y * H);
  c.rotate((l.rotation || 0) * Math.PI / 180);
  const S = Math.sqrt(W * H);   // 尺寸统一基准：位置用 W/H，大小用 S

  if (l.type === 'text') {
    const m = textMetrics(c, l, S);
    const pad = l.bgPad * m.sizePx;
    if (l.bg) {
      c.save();
      c.globalAlpha = (l.opacity ?? 1) * l.bgOpacity;
      c.fillStyle = l.bgColor;
      roundRectPath(c, -m.maxW / 2 - pad, -m.blockH / 2 - pad * 0.6,
        m.maxW + pad * 2, m.blockH + pad * 1.2, l.bgRadius * m.sizePx);
      c.fill();
      c.restore();
    }
    c.font = textFont(l, m.sizePx);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = l.color;
    c.lineJoin = 'round';
    if (l.stroke) { c.strokeStyle = l.strokeColor; c.lineWidth = l.strokeWidth * m.sizePx; }
    if (l.shadow) {
      c.save();
      c.shadowColor = l.shadowColor;
      c.shadowBlur = l.shadowBlur * m.sizePx;
      c.shadowOffsetX = l.shadowDx * m.sizePx;
      c.shadowOffsetY = l.shadowDy * m.sizePx;
      c.globalAlpha = (l.opacity ?? 1) * l.shadowOpacity;
      let yy = -m.blockH / 2 + m.lh / 2;
      m.lines.forEach((line, i) => {
        const chars = Array.from(line);
        let cursor = -m.widths[i] / 2;
        for (const ch of chars) {
          const gw = c.measureText(ch).width;
          c.fillText(ch, cursor + gw / 2, yy);
          cursor += gw + m.sp;
        }
        yy += m.lh;
      });
      c.restore();
    }
    /* 主文字 */
    c.globalAlpha = l.opacity == null ? 1 : l.opacity;
    let y = -m.blockH / 2 + m.lh / 2;
    m.lines.forEach((line, i) => {
      const chars = Array.from(line);
      let cursor = -m.widths[i] / 2;
      for (const ch of chars) {
        const gw = c.measureText(ch).width;
        if (l.stroke) c.strokeText(ch, cursor + gw / 2, y);
        c.fillText(ch, cursor + gw / 2, y);
        cursor += gw + m.sp;
      }
      y += m.lh;
    });
  }

  else if (l.type === 'image') {
    const img = l._img;
    if (img && img.naturalWidth) {
      c.imageSmoothingQuality = 'high';
      const wPx = l.w * S, hPx = wPx / l.aspect;
      c.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
    }
  }

  else if (l.type === 'doodle') {
    const lw = Math.max(0.5, l.width * S);
    c.strokeStyle = l.color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    l.pts.forEach((p, i) => {
      const px = p.dx * S, py = p.dy * S;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    });
    c.stroke();
  }

  else {
    /* line / arrow / rect / ellipse */
    const wPx = l.w * S, hPx = l.h * S;
    const lw = Math.max(0.5, l.width * S);
    c.strokeStyle = l.color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (l.type === 'line' || l.type === 'arrow') {
      const x0 = -(l.sx ?? 1) * wPx / 2, y0 = -(l.sy ?? 1) * hPx / 2;
      const x1 = (l.sx ?? 1) * wPx / 2, y1 = (l.sy ?? 1) * hPx / 2;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
      if (l.type === 'arrow') {
        const ang = Math.atan2(y1, x1);
        const hLen = clamp(S * 0.03, lw * 3.2, lw * 6);
        const tx = x1, ty = y1;
        const p1 = [tx - hLen * Math.cos(ang - 0.45), ty - hLen * Math.sin(ang - 0.45)];
        const p2 = [tx - hLen * Math.cos(ang + 0.45), ty - hLen * Math.sin(ang + 0.45)];
        c.fillStyle = l.color;
        c.beginPath();
        c.moveTo(tx, ty); c.lineTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]);
        c.closePath(); c.fill();
      }
    } else if (l.type === 'rect') {
      c.strokeRect(-wPx / 2, -hPx / 2, wPx, hPx);
    } else if (l.type === 'ellipse') {
      c.beginPath();
      c.ellipse(0, 0, wPx / 2, hPx / 2, 0, 0, Math.PI * 2);
      c.stroke();
    }
  }
  c.restore();
}

/* 图层在显示坐标中的半宽 / 半高（用于选中框与命中检测） */
function layerExtents(c, l, W, H) {
  const pad = 4;
  const S = Math.sqrt(W * H);
  if (l.type === 'text') {
    const m = textMetrics(c, l, S);
    const bgp = l.bgPad * m.sizePx;
    return { hw: m.maxW / 2 + bgp + pad, hh: m.blockH / 2 + bgp * 0.9 + pad };
  }
  if (l.type === 'image') {
    const wPx = l.w * S;
    return { hw: wPx / 2 + pad, hh: (wPx / l.aspect) / 2 + pad };
  }
  if (l.type === 'doodle') {
    return { hw: Math.max(l.w * S, 8) / 2 + pad, hh: Math.max(l.h * S, 8) / 2 + pad };
  }
  return { hw: Math.max(l.w * S, 6) / 2 + pad, hh: Math.max(l.h * S, 6) / 2 + pad };
}

const HANDLE_DEFS = [
  ['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0],
  ['se', 1, 1], ['s', 0, 1], ['sw', -1, 0], ['w', -1, 0],
];

function drawSelection(c, l, v) {
  const sp = layerScreenPos(l, v);
  const cxS = sp.x, cyS = sp.y;
  const e = layerExtents(c, l, v.W, v.H);
  const ang = (l.rotation || 0) * Math.PI / 180;
  c.save();
  c.translate(cxS, cyS);
  c.rotate(ang);
  c.strokeStyle = '#4f8cff';
  c.lineWidth = 1;
  c.setLineDash([5, 3]);
  c.strokeRect(-e.hw, -e.hh, e.hw * 2, e.hh * 2);
  c.setLineDash([]);

  if (l.type !== 'doodle') {
    c.fillStyle = '#fff';
    c.strokeStyle = '#2f6bd8';
    for (const [, sx, sy] of HANDLE_DEFS) {
      const hx = sx * e.hw, hy = sy * e.hh;
      c.fillRect(hx - 4, hy - 4, 8, 8);
      c.strokeRect(hx - 4.5, hy - 4.5, 9, 9);
    }
  }
  /* 旋转手柄 */
  const ry = -(e.hh + 22);
  c.beginPath();
  c.moveTo(0, -e.hh);
  c.lineTo(0, ry + 6);
  c.stroke();
  c.fillStyle = '#4f8cff';
  c.beginPath();
  c.arc(0, ry, 6, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#fff';
  c.beginPath();
  c.arc(0, ry, 6.5, 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

/* =====================================================================
 * 命中检测
 * ===================================================================== */
function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}
/* 屏幕坐标 -> 图层局部坐标 */
function toLocal(l, px, py, v) {
  const sp = layerScreenPos(l, v);
  const dx = px - sp.x;
  const dy = py - sp.y;
  const a = (l.rotation || 0) * Math.PI / 180;
  return { lx: Math.cos(a) * dx + Math.sin(a) * dy, ly: -Math.sin(a) * dx + Math.cos(a) * dy };
}
function localToScreen(l, lx, ly, v) {
  const sp = layerScreenPos(l, v);
  const a = (l.rotation || 0) * Math.PI / 180;
  return {
    x: sp.x + Math.cos(a) * lx - Math.sin(a) * ly,
    y: sp.y + Math.sin(a) * lx + Math.cos(a) * ly,
  };
}
function hitLayer(c, l, px, py, v) {
  const loc = toLocal(l, px, py, v);
  const e = layerExtents(c, l, v.W, v.H);
  return Math.abs(loc.lx) <= e.hw && Math.abs(loc.ly) <= e.hh;
}
function hitHandle(l, px, py, v) {
  const e = layerExtents(ctx, l, v.W, v.H);
  /* 旋转圆点 */
  const rp = localToScreen(l, 0, -(e.hh + 22), v);
  if (Math.hypot(px - rp.x, py - rp.y) <= 9) return 'rotate';
  if (l.type === 'doodle') return null;
  for (const [name, sx, sy] of HANDLE_DEFS) {
    const p = localToScreen(l, sx * e.hw, sy * e.hh, v);
    if (Math.hypot(px - p.x, py - p.y) <= 8) return name;
  }
  return null;
}

/* =====================================================================
 * 画布指针交互
 * ===================================================================== */
function relFromPointer(p, v) {
  return { x: clamp((p.px - v.cx) / v.W + 0.5, -0.25, 1.25), y: clamp((p.py - v.cy) / v.H + 0.5, -0.25, 1.25) };
}

canvas.addEventListener('pointerdown', (e) => {
  const item = cur(), v = viewDims();
  if (!item || !v || e.button !== 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件或不支持时忽略 */ }
  const p = pointerPos(e);

  /* ---------- 选择工具 ---------- */
  if (state.tool === 'select') {
    const sel = getSelected();
    if (sel) {
      const h = hitHandle(sel, p.px, p.py, v);
      if (h) {
        pushHistory();
        const loc = toLocal(sel, p.px, p.py, v);
        const e0 = layerExtents(ctx, sel, v.W, v.H);
        state.gesture = {
          mode: h === 'rotate' ? 'rotate' : 'resize',
          handle: h,
          start: p,
          startAngle: Math.atan2(loc.ly, loc.lx),
          rot0: sel.rotation || 0,
          w0: sel.w, size0: sel.size,
          hw0: e0.hw, hh0: e0.hh,
        };
        return;
      }
    }
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.visible && hitLayer(ctx, l, p.px, p.py, v)) {
        state.selectedId = l.id;
        pushHistory();
        /* 贴角图层先物化为自由坐标（记住原 pin，松手时未移动则还原） */
        let pin0 = null;
        if (l.pin) {
          pin0 = l.pin;
          const ctr = layerCenter(l, v.W, v.H);
          l.x = ctr.x; l.y = ctr.y;
        }
        state.gesture = { mode: 'move', start: p, x0: l.x, y0: l.y, pin0, moved: false };
        renderAll();
        return;
      }
    }
    state.selectedId = null;
    renderAll();
    return;
  }

  /* ---------- 文字工具 ---------- */
  if (state.tool === 'text') {
    const rp = relFromPointer(p, v);
    const l = makeTextLayer(clamp(rp.x, 0, 1), clamp(rp.y, 0, 1));
    state.layers.push(l);
    state.selectedId = l.id;
    pushHistory();
    setTool('select');
    renderAll();
    setTimeout(() => {
      const ta = $('#propPanel textarea[data-prop="text"]');
      if (ta) { ta.focus(); ta.select(); }
    }, 0);
    return;
  }

  /* ---------- 线 / 箭头 / 矩形 / 椭圆 ---------- */
  if (['line', 'arrow', 'rect', 'ellipse'].includes(state.tool)) {
    const rp = relFromPointer(p, v);
    state.gesture = { mode: 'create', kind: state.tool, start: rp };
    state.temp = makeShapeLayer(state.tool, rp.x, rp.y, state.drawColor, state.drawWidth);
    render();
    return;
  }

  /* ---------- 涂鸦 ---------- */
  if (state.tool === 'doodle') {
    const rp = relFromPointer(p, v);
    state.gesture = { mode: 'doodle', abs: [{ x: rp.x, y: rp.y }] };
    state.temp = buildDoodleLayer(state.gesture.abs);
    render();
  }
});

canvas.addEventListener('pointermove', (e) => {
  const v = viewDims();
  if (!v) return;
  const p = pointerPos(e);
  const g = state.gesture;

  if (!g) { updateCursor(p, v); return; }

  if (g.mode === 'move') {
    const l = getSelected();
    if (!l) return;
    if (!g.moved) { g.moved = true; l.pin = null; }   // 一旦拖动即解除贴角
    l.x = clamp(g.x0 + (p.px - g.start.px) / v.W, -0.3, 1.3);
    l.y = clamp(g.y0 + (p.py - g.start.py) / v.H, -0.3, 1.3);
    render();
    return;
  }

  if (g.mode === 'rotate') {
    const l = getSelected();
    const loc = toLocal(l, p.px, p.py, v);
    let rot = g.rot0 + (Math.atan2(loc.ly, loc.lx) - g.startAngle) * 180 / Math.PI;
    if (e.shiftKey) rot = Math.round(rot / 15) * 15;
    l.rotation = norm180(Math.round(rot));
    render();
    syncPropPanelValues();
    return;
  }

  if (g.mode === 'resize') {
    const l = getSelected();
    const loc = toLocal(l, p.px, p.py, v);
    if (l.type === 'image' || l.type === 'text') {
      let f;
      if (g.handle === 'e' || g.handle === 'w') f = loc.lx / (g.handle === 'w' ? -g.hw0 : g.hw0);
      else if (g.handle === 'n' || g.handle === 's') f = loc.ly / (g.handle === 'n' ? -g.hh0 : g.hh0);
      else {
        /* 角点：沿手柄方向投影求均匀缩放比，适配任意宽高比 */
        const sx = g.handle.includes('w') ? -1 : 1;
        const sy = g.handle.includes('n') ? -1 : 1;
        const rx = sx * g.hw0, ry = sy * g.hh0;
        f = (loc.lx * rx + loc.ly * ry) / (rx * rx + ry * ry);
      }
      f = clamp(f, 0.05, 20);
      if (l.type === 'image') l.w = clamp(g.w0 * f, 0.02, 1.5);
      else l.size = clamp(g.size0 * f, 0.005, 0.5);
    } else {
      /* 形状：中心对称缩放 */
      let hw = g.hw0 - 4, hh = g.hh0 - 4;
      const sx = g.handle.includes('w') ? -1 : g.handle.includes('e') ? 1 : 0;
      const sy = g.handle.includes('n') ? -1 : g.handle.includes('s') ? 1 : 0;
      if (sx) hw = Math.max(4, sx * loc.lx);
      if (sy) hh = Math.max(4, sy * loc.ly);
      if (e.shiftKey) {
        const f = Math.max(hw / (g.hw0 - 4), hh / (g.hh0 - 4));
        hw = (g.hw0 - 4) * f; hh = (g.hh0 - 4) * f;
      }
      l.w = hw * 2 / v.S;
      l.h = hh * 2 / v.S;
    }
    render();
    syncPropPanelValues();
    return;
  }

  if (g.mode === 'create') {
    const rp = relFromPointer(p, v);
    const s = g.start;
    state.temp.x = (s.x + rp.x) / 2;
    state.temp.y = (s.y + rp.y) / 2;
    /* 屏幕物理宽高换算到统一尺寸基准 S（保证不同宽高比图上形状大小一致） */
    state.temp.w = Math.abs(rp.x - s.x) * v.W / v.S;
    state.temp.h = Math.abs(rp.y - s.y) * v.H / v.S;
    state.temp.sx = rp.x >= s.x ? 1 : -1;
    state.temp.sy = rp.y >= s.y ? 1 : -1;
    render();
    return;
  }

  if (g.mode === 'doodle') {
    const rp = relFromPointer(p, v);
    const last = g.abs[g.abs.length - 1];
    if (Math.hypot((rp.x - last.x) * v.W, (rp.y - last.y) * v.H) > 1.5) {
      g.abs.push({ x: rp.x, y: rp.y });
      state.temp = buildDoodleLayer(g.abs);
      render();
    }
  }
});

canvas.addEventListener('pointerup', () => {
  const g = state.gesture;
  if (!g) { return; }

  if (g.mode === 'create' && state.temp) {
    const t = state.temp;
    const vUp = viewDims();
    if (t.w * vUp.S > 4 || t.h * vUp.S > 4) {
      state.layers.push(t);
      state.selectedId = t.id;
      pushHistory();
    }
  } else if (g.mode === 'doodle' && state.temp) {
    const t = state.temp;
    if (t.pts.length > 1) {
      state.layers.push(t);
      state.selectedId = t.id;
      pushHistory();
    }
  } else if (g.mode === 'move') {
    const l = getSelected();
    if (l) {
      if (!g.moved && g.pin0) {
        l.pin = g.pin0;            // 原地点击未拖动：保持原贴角
      } else {
        trySnapPin(l, viewDims()); // 拖动后靠近边角 → 自动贴角
      }
    }
    pushHistory();
  } else if (['resize', 'rotate'].includes(g.mode)) {
    pushHistory();
  }
  state.gesture = null;
  state.temp = null;
  renderAll();
});

/* 拖动结束后：若图层贴近图片边角，则自动「贴角固定」——
 * 之后在任意分辨率/宽高比的图片上都会保持相同的边角边距。 */
function trySnapPin(l, v) {
  if (!l || !v) return;
  const S = v.S;
  const e = layerExtents(ctx, l, v.W, v.H);
  const ctr = layerCenter(l, v.W, v.H);   // 此时 pin 已解除，即自由坐标
  const zone = Math.max(0.035 * S, 14);
  const left = ctr.x * v.W - e.hw;
  const right = v.W - (ctr.x * v.W + e.hw);
  const top = ctr.y * v.H - e.hh;
  const bottom = v.H - (ctr.y * v.H + e.hh);
  let hx = 0, hy = 0, mx = 0, my = 0, hit = false;
  if (left <= zone && ctr.x < 0.5) { hx = -1; mx = Math.max(0, left) / S; hit = true; }
  else if (right <= zone && ctr.x > 0.5) { hx = 1; mx = Math.max(0, right) / S; hit = true; }
  if (top <= zone && ctr.y < 0.5) { hy = -1; my = Math.max(0, top) / S; hit = true; }
  else if (bottom <= zone && ctr.y > 0.5) { hy = 1; my = Math.max(0, bottom) / S; hit = true; }
  if (hit) {
    l.pin = { hx, hy, mx, my };
    toast('已贴角固定：所有图片上自动对齐此边角（拖离边角可取消）', 'ok');
  }
}

function buildDoodleLayer(abs) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of abs) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const l = makeShapeLayer('doodle', cx, cy, state.drawColor, state.drawWidth);
  /* 偏移量换算到统一尺寸基准 S（x 方向按宽、y 方向按高分别折算） */
  const v = viewDims();
  const kW = v ? v.W / v.S : 1, kH = v ? v.H / v.S : 1;
  l.pts = abs.map((p) => ({ dx: (p.x - cx) * kW, dy: (p.y - cy) * kH }));
  l.w = Math.max((maxX - minX) * kW, 0.0001);
  l.h = Math.max((maxY - minY) * kH, 0.0001);
  return l;
}

function updateCursor(p, v) {
  const sel = getSelected();
  if (state.tool !== 'select') {
    canvas.style.cursor = state.tool === 'doodle' ? 'crosshair' : 'crosshair';
    return;
  }
  if (sel) {
    const h = hitHandle(sel, p.px, p.py, v);
    const curMap = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
      rotate: 'grab',
    };
    if (h) { canvas.style.cursor = curMap[h] || 'pointer'; return; }
  }
  for (let i = state.layers.length - 1; i >= 0; i--) {
    if (state.layers[i].visible && hitLayer(ctx, state.layers[i], p.px, p.py, v)) {
      canvas.style.cursor = 'move';
      return;
    }
  }
  canvas.style.cursor = 'default';
}

/* =====================================================================
 * 工具栏 / 工具切换
 * ===================================================================== */
function setTool(t) {
  state.tool = t;
  $$('#toolGroup .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}
$$('#toolGroup .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

$('#drawColor').addEventListener('input', (e) => { state.drawColor = e.target.value; });
$('#drawWidth').addEventListener('input', (e) => {
  state.drawWidth = parseFloat(e.target.value);
  $('#drawWidthVal').textContent = (state.drawWidth * 100).toFixed(2) + '%';
});

$('#btnRotateL').addEventListener('click', () => rotateImage(cur(), -90));
$('#btnRotateR').addEventListener('click', () => rotateImage(cur(), 90));

$('#btnZoomIn').addEventListener('click', () => { state.zoom = clamp(state.zoom * 1.2, 0.1, 8); render(); });
$('#btnZoomOut').addEventListener('click', () => { state.zoom = clamp(state.zoom / 1.2, 0.1, 8); render(); });
$('#btnZoomFit').addEventListener('click', () => { fitView(); render(); });
$('#stage').addEventListener('wheel', (e) => {
  if (!cur()) return;
  e.preventDefault();
  state.zoom = clamp(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 8);
  render();
}, { passive: false });

/* =====================================================================
 * 图层列表
 * ===================================================================== */
const LAYER_ICONS = {
  text: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 6h14M12 6v13M9 19h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor"/><path d="M4 17l5-4 4 3 3-2 4 3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  line: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 19L19 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 19L19 5M19 5h-7M19 5v7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  rect: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" width="14" height="14"><ellipse cx="12" cy="12" rx="8" ry="6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  doodle: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 17c3-1 5-6 7-8s5-4 7-2-2 5-4 7-6 4-9 4l-1-1z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
};

function renderLayerList() {
  const box = $('#layerList');
  if (!state.layers.length) {
    box.innerHTML = '<p class="muted tiny">水印 / 文字 / 标注都在此统一管理</p>';
    return;
  }
  box.innerHTML = state.layers.slice().reverse().map((l) => `
    <div class="layer-item ${l.id === state.selectedId ? 'selected' : ''}" data-id="${l.id}">
      <span class="li-icon">${LAYER_ICONS[l.type] || ''}</span>
      <span class="li-name">${layerName(l)}</span>
      <button class="li-eye ${l.visible ? 'on' : ''}" data-eye="${l.id}" title="显示 / 隐藏">${l.visible ? '👁' : '—'}</button>
    </div>`).join('');
}
$('#layerList').addEventListener('click', (e) => {
  const eye = e.target.closest('[data-eye]');
  if (eye) {
    const l = state.layers.find((x) => x.id === eye.dataset.eye);
    if (l) { l.visible = !l.visible; pushHistory(); renderAll(); }
    return;
  }
  const item = e.target.closest('.layer-item');
  if (item) {
    state.selectedId = item.dataset.id;
    setTool('select');
    renderAll();
  }
});
function moveSelectedLayer(dir) {
  const l = getSelected();
  if (!l) return;
  const i = state.layers.indexOf(l);
  const j = i + dir;
  if (j < 0 || j >= state.layers.length) return;
  state.layers[i] = state.layers[j];
  state.layers[j] = l;
  pushHistory();
  renderAll();
}
$('#btnLayerUp').addEventListener('click', () => moveSelectedLayer(1));
$('#btnLayerDown').addEventListener('click', () => moveSelectedLayer(-1));
$('#btnLayerDel').addEventListener('click', deleteSelectedLayer);

function deleteSelectedLayer() {
  const l = getSelected();
  if (!l) return;
  state.layers = state.layers.filter((x) => x.id !== l.id);
  state.selectedId = null;
  pushHistory();
  renderAll();
}

/* =====================================================================
 * 属性面板
 * ===================================================================== */
const FMT = {
  size: (v) => (v * 100).toFixed(1) + '%',
  w: (v) => (v * 100).toFixed(1) + '%',
  width: (v) => (v * 100).toFixed(2) + '%',
  opacity: (v) => Math.round(v * 100) + '%',
  bgOpacity: (v) => Math.round(v * 100) + '%',
  shadowOpacity: (v) => Math.round(v * 100) + '%',
  strokeWidth: (v) => Math.round(v * 100) + '%',
  shadowBlur: (v) => Math.round(v * 100) + '%',
  shadowDx: (v) => Math.round(v * 100) + '%',
  shadowDy: (v) => Math.round(v * 100) + '%',
  bgPad: (v) => Math.round(v * 100) + '%',
  bgRadius: (v) => Math.round(v * 100) + '%',
  spacing: (v) => (v * 100).toFixed(0) + '%',
  rotation: (v) => v + '°',
};
function fmtEm(prop, v) { return (FMT[prop] || ((x) => x))(v); }

function row(inner, label) {
  return `<label class="field"><span>${label}</span>${inner}</label>`;
}
function rangeRow(prop, label, min, max, step, l) {
  return `<label class="field"><span>${label} <em>${fmtEm(prop, l[prop])}</em></span>
    <input type="range" data-prop="${prop}" min="${min}" max="${max}" step="${step}" value="${l[prop]}"></label>`;
}
function colorRow(prop, label, l) {
  return `<label class="field"><span>${label}</span><input type="color" data-prop="${prop}" value="${l[prop]}"></label>`;
}
function checkRow(prop, label, l) {
  return `<label class="check-line"><input type="checkbox" data-prop="${prop}" ${l[prop] ? 'checked' : ''}>${label}</label>`;
}
function segFlag(prop, label, on, icon) {
  return `<button type="button" class="${on ? 'on' : ''}" data-flag="${prop}">${icon}</button>`;
}

function renderPropPanel() {
  const box = $('#propPanel');
  const l = getSelected();
  if (!l) {
    box.innerHTML = '<p class="muted tiny">在画布上选中一个图层后，可在此调整详细参数；点击「文字」工具可添加文字水印。</p>';
    return;
  }
  let h = '';

  if (l.type === 'text') {
    h += `<label class="field"><span>文字内容（支持多行）</span>
      <textarea data-prop="text" rows="2">${escapeHtml(l.text)}</textarea></label>`;
    const fontOpts = FONTS.map(([v, n]) =>
      `<option value='${v}' ${l.font === v ? 'selected' : ''} style="font-family:${v},sans-serif">${n}</option>`).join('');
    h += row(`<select data-prop="font">${fontOpts}</select>`, '字体');
    h += `<div class="field"><span>样式</span><div class="seg">
      ${segFlag('bold', '加粗', l.bold, 'B')}
      ${segFlag('italic', '斜体', l.italic, 'I')}
    </div></div>`;
    h += rangeRow('size', '字号（相对画面大小）', 0.008, 0.4, 0.001, l);
    h += rangeRow('spacing', '字间距', 0, 1, 0.01, l);
    h += `<div class="field-grid-2">
      ${colorRow('color', '文字颜色', l)}
      ${rangeRow('opacity', '不透明度', 0.05, 1, 0.01, l)}
    </div>`;
    h += `<div class="sub-group">
      <div class="sg-title"><label class="check-line"><input type="checkbox" data-prop="stroke" ${l.stroke ? 'checked' : ''}>描边 / 外轮廓</label></div>
      <div class="field-grid-2">
        ${colorRow('strokeColor', '描边颜色', l)}
        ${rangeRow('strokeWidth', '描边粗细', 0, 0.4, 0.01, l)}
      </div>
    </div>`;
    h += `<div class="sub-group">
      <div class="sg-title"><label class="check-line"><input type="checkbox" data-prop="shadow" ${l.shadow ? 'checked' : ''}>阴影</label></div>
      <div class="field-grid-2">${colorRow('shadowColor', '阴影颜色', l)}${rangeRow('shadowOpacity', '阴影浓度', 0, 1, 0.01, l)}</div>
      ${rangeRow('shadowBlur', '模糊程度', 0, 1, 0.01, l)}
      <div class="field-grid-2">${rangeRow('shadowDx', '横向偏移', -0.5, 0.5, 0.01, l)}${rangeRow('shadowDy', '纵向偏移', -0.5, 0.5, 0.01, l)}</div>
    </div>`;
    h += `<div class="sub-group">
      <div class="sg-title"><label class="check-line"><input type="checkbox" data-prop="bg" ${l.bg ? 'checked' : ''}>底色标签</label></div>
      <div class="field-grid-2">${colorRow('bgColor', '底色', l)}${rangeRow('bgOpacity', '底色不透明度', 0, 1, 0.01, l)}</div>
      <div class="field-grid-2">${rangeRow('bgPad', '内边距', 0, 0.6, 0.01, l)}${rangeRow('bgRadius', '圆角', 0, 1, 0.01, l)}</div>
    </div>`;
    h += rotationRows(l);
  }

  else if (l.type === 'image') {
    h += rangeRow('w', 'Logo 宽度（相对画面大小）', 0.03, 1, 0.005, l);
    h += rangeRow('opacity', '不透明度', 0.05, 1, 0.01, l);
    h += rotationRows(l);
    h += `<p class="muted tiny">提示：可直接在画布上拖动 Logo，拖动控制点缩放，顶部圆点旋转。</p>`;
  }

  else if (['line', 'arrow', 'rect', 'ellipse'].includes(l.type)) {
    h += `<div class="field-grid-2">
      ${colorRow('color', '线条颜色', l)}
      ${rangeRow('width', '线条粗细', 0.0005, 0.03, 0.0005, l)}
    </div>`;
    h += rangeRow('opacity', '不透明度', 0.05, 1, 0.01, l);
    h += rotationRows(l);
  }

  else if (l.type === 'doodle') {
    h += `<div class="field-grid-2">
      ${colorRow('color', '画笔颜色', l)}
      ${rangeRow('width', '画笔粗细', 0.0005, 0.03, 0.0005, l)}
    </div>`;
    h += rangeRow('opacity', '不透明度', 0.05, 1, 0.01, l);
    h += rotationRows(l);
  }

  box.innerHTML = h;
}
function rotationRows(l) {
  return `<label class="field"><span>旋转角度 <em>${l.rotation}°</em></span>
    <input type="range" data-prop="rotation" min="-180" max="180" step="1" value="${l.rotation}"></label>
    <div class="field-row" style="margin-bottom:9px">
      <button type="button" class="btn small grow" data-rot90="-90">-90°</button>
      <button type="button" class="btn small grow" data-rot90="90">+90°</button>
      <button type="button" class="btn small grow" data-rot90="reset">复位</button>
    </div>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* 属性面板事件（事件委托） */
const propPanel = $('#propPanel');
propPanel.addEventListener('pointerdown', (e) => {
  if (e.target.matches('input[type="range"]')) pushHistory();
});
propPanel.addEventListener('focusin', (e) => {
  if (e.target.matches('input[type="text"],textarea,input[type="number"]')) pushHistory();
});
propPanel.addEventListener('input', (e) => {
  const el = e.target.closest('[data-prop]');
  const l = getSelected();
  if (!el || !l) return;
  const p = el.dataset.prop;
  if (el.type === 'checkbox') l[p] = el.checked;
  else if (el.type === 'range' || el.type === 'number') l[p] = parseFloat(el.value);
  else l[p] = el.value;
  const em = el.closest('.field') && el.closest('.field').querySelector('em');
  if (em && el.type === 'range') em.textContent = fmtEm(p, l[p]);
  if (p === 'rotation') { /* rotation em 更新 */ }
  render();
  if (l.type === 'text') renderLayerList();
});
propPanel.addEventListener('change', (e) => {
  const el = e.target.closest('[data-prop]');
  if (!el) return;
  pushHistory();
  if (el.tagName === 'SELECT' || el.type === 'color' || el.type === 'checkbox') renderAll();
});
propPanel.addEventListener('click', (e) => {
  const l = getSelected();
  if (!l) return;
  const flag = e.target.closest('[data-flag]');
  if (flag) {
    pushHistory();
    l[flag.dataset.flag] = !l[flag.dataset.flag];
    renderAll();
    return;
  }
  const rotBtn = e.target.closest('[data-rot90]');
  if (rotBtn) {
    pushHistory();
    const v = rotBtn.dataset.rot90;
    l.rotation = v === 'reset' ? 0 : norm180(l.rotation + parseInt(v, 10));
    renderAll();
  }
});
/* 画布手势过程中同步面板滑块（不重建 DOM） */
function syncPropPanelValues() {
  const l = getSelected();
  if (!l) return;
  propPanel.querySelectorAll('[data-prop]').forEach((el) => {
    const p = el.dataset.prop;
    if (l[p] == null) return;
    if (el.type === 'range') {
      el.value = l[p];
      const em = el.closest('.field') && el.closest('.field').querySelector('em');
      if (em) em.textContent = fmtEm(p, l[p]);
    }
  });
}

/* 九宫格定位：角/边按钮设为「贴角」，在所有图片上自动对齐；mc 为自由居中 */
$('#posGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pos]');
  const l = getSelected();
  if (!b || !l) return;
  const pinMap = {
    tl: { hx: -1, hy: -1 }, tc: { hx: 0, hy: -1 }, tr: { hx: 1, hy: -1 },
    ml: { hx: -1, hy: 0 },  mc: null,                mr: { hx: 1, hy: 0 },
    bl: { hx: -1, hy: 1 },  bc: { hx: 0, hy: 1 },  br: { hx: 1, hy: 1 },
  };
  const pin = pinMap[b.dataset.pos];
  pushHistory();
  if (!pin) {
    l.pin = null;
    l.x = 0.5; l.y = 0.5;
  } else {
    /* 未固定的轴保持当前相对位置；固定轴使用默认边距 */
    l.pin = { hx: pin.hx, hy: pin.hy, mx: 0.03, my: 0.03 };
    if (pin.hx === 0) l.x = 0.5;
    if (pin.hy === 0) l.y = 0.5;
  }
  renderAll();
});

/* =====================================================================
 * 缩略图列表
 * ===================================================================== */
function renderThumbs() {
  const box = $('#thumbList');
  $('#imgCount').textContent = state.images.length;
  if (!state.images.length) {
    box.innerHTML = `<div class="thumb-empty">
      <svg viewBox="0 0 24 24" width="34" height="34"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" fill="currentColor"/><path d="M4 17l5-4 4 3 3-2 4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      <p>拖入图片或点击「导入图片」</p>
      <p class="sub">支持 JPG / PNG / WebP / BMP / GIF</p></div>`;
    return;
  }
  box.innerHTML = state.images.map((it, i) => `
    <div class="thumb ${i === state.current ? 'active' : ''}" data-id="${it.id}">
      <img class="thumb-img" src="${it.thumbUrl}" alt="">
      <div class="thumb-meta">
        <div class="thumb-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
        <div class="thumb-sub">${it.bw}×${it.bh}</div>
      </div>
      <div class="thumb-actions">
        <button class="tbtn rot" data-act="rot" title="顺时针旋转 90°">↻</button>
        <button class="tbtn" data-act="del" title="移除">✕</button>
      </div>
      ${it.rotation ? `<span class="rot-dot">${it.rotation}°</span>` : ''}
    </div>`).join('');
}
$('#thumbList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const wrap = e.target.closest('.thumb');
  if (!wrap) return;
  const id = wrap.dataset.id;
  if (btn) {
    e.stopPropagation();
    const item = state.images.find((x) => x.id === id);
    if (btn.dataset.act === 'rot') rotateImage(item, 90);
    else removeImage(id);
    return;
  }
  state.current = state.images.findIndex((x) => x.id === id);
  fitView();
  renderAll();
});

/* =====================================================================
 * 文件导入 / Logo / 拖放 / 粘贴
 * ===================================================================== */
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#emptyImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });

$('#btnLogo').addEventListener('click', () => $('#logoInput').click());
$('#logoInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const src = await readAsDataURL(f);
    const img = await loadHtmlImage(src);
    state.logoCache.set(src, img);
    const l = makeImageLayer(img, src);
    state.layers.push(l);
    state.selectedId = l.id;
    pushHistory();
    renderAll();
    toast('Logo 已添加，可在画布上拖动调整', 'ok');
  } catch (err) {
    toast('Logo 读取失败', 'err');
  }
});

/* 拖放 */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    e.preventDefault();
    dragDepth++;
    $('#dropMask').classList.remove('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#dropMask').classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropMask').classList.add('hidden');
  if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

/* 粘贴 */
window.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items || []) {
    if (item.kind === 'file' && /^image\//.test(item.type)) {
      const f = item.getAsFile();
      if (f) files.push(new File([f], 'pasted-' + Date.now() + '.png', { type: f.type }));
    }
  }
  if (files.length) importFiles(files);
});

/* =====================================================================
 * 键盘快捷键
 * ===================================================================== */
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = ['input', 'textarea', 'select'].includes(tag);
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z') {
    if (typing) return; // 文本框内保留原生撤销
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    if (typing) return;
    e.preventDefault(); redo();
    return;
  }
  if (typing) return;

  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedLayer(); return; }
  if (e.key === 'Escape') { state.selectedId = null; setTool('select'); renderAll(); return; }
  const toolMap = { v: 'select', t: 'text', l: 'line', a: 'arrow', r: 'rect', e: 'ellipse', d: 'doodle' };
  if (toolMap[e.key.toLowerCase()]) { setTool(toolMap[e.key.toLowerCase()]); return; }
  const l = getSelected();
  if (l && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const v = viewDims();
    if (l.pin && v) {   // 微调贴角图层：先转为自由位置
      const ctr = layerCenter(l, v.W, v.H);
      l.x = ctr.x; l.y = ctr.y; l.pin = null;
    }
    const step = e.shiftKey ? 0.02 : 0.003;
    if (e.key === 'ArrowLeft') l.x -= step;
    if (e.key === 'ArrowRight') l.x += step;
    if (e.key === 'ArrowUp') l.y -= step;
    if (e.key === 'ArrowDown') l.y += step;
    render();
    clearTimeout(l._nudgeT);
    l._nudgeT = setTimeout(pushHistory, 250);
  }
});

$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);

/* =====================================================================
 * 状态栏
 * ===================================================================== */
function updateStatus(v) {
  const item = cur();
  if (!item) {
    $('#statusName').textContent = '未载入图片';
    $('#statusSize').textContent = '';
    $('#statusRot').textContent = '';
    $('#zoomLabel').textContent = '100%';
    return;
  }
  $('#statusName').textContent = item.name;
  const d = orientedDims(item);
  $('#statusSize').textContent = `${d.w}×${d.h}`;
  $('#statusRot').textContent = item.rotation ? `旋转 ${item.rotation}°` : '';
  $('#zoomLabel').textContent = Math.round(state.baseScale * state.zoom * 100) + '%';
}

/* =====================================================================
 * 导出
 * ===================================================================== */
const outFormat = $('#outFormat');
const qualityField = $('#qualityField');
function updateQualityVisibility() {
  qualityField.style.display = outFormat.value === 'image/png' ? 'none' : '';
}
outFormat.addEventListener('change', updateQualityVisibility);
$('#outQuality').addEventListener('input', (e) => {
  $('#qualityVal').textContent = Math.round(e.target.value * 100) + '%';
});

$('#btnPickDir').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    toast('当前浏览器不支持选择文件夹，将自动使用 ZIP 打包下载', 'err');
    return;
  }
  try {
    state.outDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    updateDirHint();
    toast('已选择输出文件夹：' + state.outDirHandle.name, 'ok');
  } catch (e) { /* 用户取消 */ }
});
$('#btnClearDir').addEventListener('click', () => {
  state.outDirHandle = null;
  updateDirHint();
});
function updateDirHint() {
  $('#outDirHint').textContent = state.outDirHandle
    ? '所有水印图片将直接写入文件夹：' + state.outDirHandle.name
    : '未选择文件夹时，将自动打包为 ZIP 下载到本地。';
}

function targetOutput(item) {
  let mime, ext;
  const fmt = outFormat.value;
  if (fmt === 'original') {
    const n = item.name.toLowerCase();
    if (/\.(jpg|jpeg)$/.test(n)) { mime = 'image/jpeg'; ext = '.jpg'; }
    else if (/\.webp$/.test(n) && SUPPORT_WEBP) { mime = 'image/webp'; ext = '.webp'; }
    else { mime = 'image/png'; ext = '.png'; }
  } else {
    mime = fmt;
    ext = mime === 'image/jpeg' ? '.jpg' : '.' + mime.split('/')[1];
    if (mime === 'image/webp' && !SUPPORT_WEBP) { mime = 'image/png'; ext = '.png'; }
  }
  return { mime, ext };
}

function renderExportCanvas(item) {
  const d = orientedDims(item);
  const c = document.createElement('canvas');
  c.width = d.w; c.height = d.h;
  const ex = c.getContext('2d');
  const { mime } = targetOutput(item);
  if (mime === 'image/jpeg') {
    ex.fillStyle = '#ffffff';
    ex.fillRect(0, 0, d.w, d.h);
  }
  /* 原图（含旋转） */
  ex.save();
  ex.imageSmoothingQuality = 'high';
  ex.translate(d.w / 2, d.h / 2);
  ex.rotate(item.rotation * Math.PI / 180);
  ex.drawImage(item.bitmap, -item.bw / 2, -item.bh / 2, item.bw, item.bh);
  ex.restore();
  /* 水印图层：直接在原始分辨率坐标空间绘制 */
  for (const l of state.layers) {
    if (l.visible) drawLayer(ex, l, d.w, d.h, 0, 0);
  }
  return { canvas: c, mime };
}

async function writeToDir(handle, name, blob) {
  const fh = await handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

let cancelExport = false;
async function exportAll() {
  if (!state.images.length) { toast('请先导入图片', 'err'); return; }

  const mask = $('#modalMask');
  const bar = $('#progressBar');
  const text = $('#modalText');
  const cancelBtn = $('#btnCancelExport');
  const closeBtn = $('#btnModalClose');
  mask.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  closeBtn.classList.add('hidden');
  bar.style.width = '0%';
  cancelExport = false;

  const suffix = $('#outSuffix').value || '';
  const quality = parseFloat($('#outQuality').value);
  const useDir = !!state.outDirHandle;
  const zip = useDir ? null : new SimpleZip();
  const usedNames = new Set();
  const failures = [];
  let done = 0;
  const total = state.images.length;
  const stamp = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const zipName = `watermarked_${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}_${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}.zip`;

  try {
    for (const item of state.images) {
      if (cancelExport) break;
      try {
        const { canvas: ec, mime } = renderExportCanvas(item);
        const { ext } = targetOutput(item);
        let base = item.name.replace(/\.[^.]+$/, '');
        let name = base + suffix + ext;
        let k = 1;
        while (usedNames.has(name.toLowerCase())) name = `${base}${suffix}(${k++})${ext}`;
        usedNames.add(name.toLowerCase());
        const blob = await canvasToBlob(ec, mime, mime === 'image/png' ? undefined : quality);
        if (useDir) await writeToDir(state.outDirHandle, name, blob);
        else zip.addFile(name, blob);
      } catch (err) {
        console.error('导出失败', item.name, err);
        failures.push(item.name);
      }
      done++;
      bar.style.width = (done / total * 100) + '%';
      text.textContent = `正在导出 ${done} / ${total}：${item.name}`;
      if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    if (cancelExport) {
      text.textContent = `已取消（完成 ${done} / ${total}）`;
    } else if (!useDir) {
      text.textContent = '正在打包 ZIP…';
      const blob = await zip.generate();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      text.textContent = failures.length
        ? `已打包下载（成功 ${done - failures.length} 张，失败 ${failures.length} 张）`
        : `全部 ${done} 张图片已打包下载：${zipName}`;
    } else {
      text.textContent = failures.length
        ? `已写入文件夹（成功 ${done - failures.length} 张，失败 ${failures.length} 张）`
        : `全部 ${done} 张图片已导出到文件夹：${state.outDirHandle.name}`;
    }
    if (failures.length) text.textContent += '；失败：' + failures.slice(0, 3).join('、') + (failures.length > 3 ? ' 等' : '');
    if (!cancelExport && !failures.length) toast('导出完成', 'ok');
  } catch (err) {
    console.error(err);
    text.textContent = '导出出错：' + err.message;
  }
  cancelBtn.classList.add('hidden');
  closeBtn.classList.remove('hidden');
}
$('#btnExport').addEventListener('click', exportAll);
$('#btnExportTop').addEventListener('click', exportAll);
$('#btnCancelExport').addEventListener('click', () => { cancelExport = true; });
$('#btnModalClose').addEventListener('click', () => $('#modalMask').classList.add('hidden'));

/* =====================================================================
 * 统一渲染 & 初始化
 * ===================================================================== */
function renderAll() {
  render();
  renderThumbs();
  renderLayerList();
  renderPropPanel();
  updateUndoBtns();
}
window.addEventListener('resize', debounce(() => { fitView(); render(); }, 80));

pushHistory();   // 初始空状态入栈
fitView();
renderAll();
updateQualityVisibility();
updateDirHint();
