/**
 * ColorSystem — Full color management
 * - Canvas-rendered color wheel (HSB)
 * - Color square (S/B picker)
 * - Color history (20)
 * - Harmony generator
 * - HSB ↔ RGB ↔ HEX conversion
 */
export class ColorSystem {
  constructor() {
    this.h = 0;    // 0-360
    this.s = 0;    // 0-100
    this.b = 0;    // 0-100  → starts as black
    this.a = 100;  // 0-100

    this.history = [];
    this.maxHistory = 20;
    this.onChange = null;
    this.harmonyMode = 'complementary';

    this._draggingWheel = false;
    this._draggingSquare = false;

    this._wheelCanvas = null;
    this._squareCanvas = null;
    this._wheelCtx = null;
    this._squareCtx = null;
    this._wheelRadius = 0;
    this._squareSize = 0;
  }

  init(wheelEl, squareEl) {
    this._wheelCanvas = wheelEl;
    this._squareCanvas = squareEl;
    this._wheelCtx = wheelEl.getContext('2d');
    this._squareCtx = squareEl.getContext('2d');

    this._resizeObserver = new ResizeObserver(() => this._redraw());
    this._resizeObserver.observe(wheelEl.parentElement);

    this._renderWheel();
    this._renderSquare();
    this._bindCanvasEvents();
  }

  _resizeCanvases() {
    const parent = this._wheelCanvas.parentElement;
    // Account for padding and clamp to max 220px to prevent overflow on mobile
    const w = Math.max(10, Math.min(parent.clientWidth - 28, 220)); 
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._wheelCanvas.width = w * dpr;
    this._wheelCanvas.height = w * dpr;
    this._wheelCanvas.style.width = w + 'px';
    this._wheelCanvas.style.height = w + 'px';

    const sqH = Math.round(w * 0.65);
    this._squareCanvas.width = w * dpr;
    this._squareCanvas.height = sqH * dpr;
    this._squareCanvas.style.width = w + 'px';
    this._squareCanvas.style.height = sqH + 'px';

    this._wheelRadius = (w / 2) * dpr;
    this._squareSize = { w: w * dpr, h: sqH * dpr };
  }

  _redraw() {
    this._resizeCanvases();
    this._renderWheel();
    this._renderSquare();
  }

  _renderWheel() {
    const ctx = this._wheelCtx;
    const c = this._wheelCanvas;
    const cx = c.width / 2, cy = c.height / 2;
    const r = cx * 0.88;
    const innerR = r * 0.65;

    ctx.clearRect(0, 0, c.width, c.height);

    // Draw hue wheel
    for (let angle = 0; angle < 360; angle += 1) {
      const startAngle = (angle - 1) * Math.PI / 180;
      const endAngle = (angle + 1) * Math.PI / 180;
      const grd = ctx.createRadialGradient(cx, cy, innerR, cx, cy, r);
      grd.addColorStop(0, `hsla(${angle},0%,50%,1)`);
      grd.addColorStop(1, `hsla(${angle},100%,50%,1)`);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Inner hole
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Hue indicator
    const hRad = (this.h - 90) * Math.PI / 180;
    const indR = (r + innerR) / 2;
    const ix = cx + indR * Math.cos(hRad);
    const iy = cy + indR * Math.sin(hRad);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.fillStyle = this.toHex();
    ctx.beginPath();
    ctx.arc(ix, iy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  _renderSquare() {
    const ctx = this._squareCtx;
    const c = this._squareCanvas;
    const w = c.width, h = c.height;

    ctx.clearRect(0, 0, w, h);

    // Saturation gradient (horizontal)
    const grdH = ctx.createLinearGradient(0, 0, w, 0);
    grdH.addColorStop(0, `hsl(${this.h},0%,100%)`);
    grdH.addColorStop(1, `hsl(${this.h},100%,50%)`);
    ctx.fillStyle = grdH;
    ctx.fillRect(0, 0, w, h);

    // Brightness gradient (vertical, black overlay)
    const grdV = ctx.createLinearGradient(0, 0, 0, h);
    grdV.addColorStop(0, 'rgba(0,0,0,0)');
    grdV.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = grdV;
    ctx.fillRect(0, 0, w, h);

    // Cross cursor
    const cx = (this.s / 100) * w;
    const cy = (1 - this.b / 100) * h;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fillStyle = this.toHex();
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  _bindCanvasEvents() {
    // Wheel events
    const wheelEl = this._wheelCanvas;
    const squareEl = this._squareCanvas;

    const onWheelDown = (e) => { e.preventDefault(); this._draggingWheel = true; this._pickHue(e); };
    const onWheelMove = (e) => { e.preventDefault(); if (this._draggingWheel) this._pickHue(e); };
    const onWheelUp = () => { this._draggingWheel = false; };

    wheelEl.addEventListener('pointerdown', onWheelDown, { passive: false });
    wheelEl.addEventListener('pointermove', onWheelMove, { passive: false });
    wheelEl.addEventListener('pointerup', onWheelUp);

    const onSqDown = (e) => { e.preventDefault(); this._draggingSquare = true; this._pickSB(e); };
    const onSqMove = (e) => { e.preventDefault(); if (this._draggingSquare) this._pickSB(e); };
    const onSqUp = () => { this._draggingSquare = false; };

    squareEl.addEventListener('pointerdown', onSqDown, { passive: false });
    squareEl.addEventListener('pointermove', onSqMove, { passive: false });
    squareEl.addEventListener('pointerup', onSqUp);
  }

  _pickHue(e) {
    const rect = this._wheelCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cx = this._wheelCanvas.width / 2;
    const cy = this._wheelCanvas.height / 2;
    const x = (e.clientX - rect.left) * dpr - cx;
    const y = (e.clientY - rect.top) * dpr - cy;
    const dist = Math.sqrt(x * x + y * y);
    const innerR = cx * 0.88 * 0.65;
    const outerR = cx * 0.88;

    if (dist >= innerR && dist <= outerR) {
      this.h = ((Math.atan2(y, x) * 180 / Math.PI) + 90 + 360) % 360;
      this._redrawAndEmit();
    }
  }

  _pickSB(e) {
    const rect = this._squareCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this._squareCanvas.width;
    const h = this._squareCanvas.height;
    const x = Math.max(0, Math.min(w, (e.clientX - rect.left) * dpr));
    const y = Math.max(0, Math.min(h, (e.clientY - rect.top) * dpr));
    this.s = (x / w) * 100;
    this.b = (1 - y / h) * 100;
    this._redrawAndEmit();
  }

  _redrawAndEmit() {
    if (!this._wheelCanvas || !this._squareCanvas) {
      if (this.onChange) this.onChange(this.getState());
      return;
    }
    this._renderWheel();
    this._renderSquare();
    if (this.onChange) this.onChange(this.getState());
  }

  // ── Public API ──

  setH(v) { this.h = ((v % 360) + 360) % 360; this._redrawAndEmit(); }
  setS(v) { this.s = Math.max(0, Math.min(100, v)); this._redrawAndEmit(); }
  setB(v) { this.b = Math.max(0, Math.min(100, v)); this._redrawAndEmit(); }
  setA(v) { this.a = Math.max(0, Math.min(100, v)); if (this.onChange) this.onChange(this.getState()); }

  setHex(hex) {
    hex = hex.replace('#', '');
    if (hex.length !== 6) return;
    const r = parseInt(hex.slice(0,2),16)/255;
    const g = parseInt(hex.slice(2,4),16)/255;
    const b = parseInt(hex.slice(4,6),16)/255;
    const [h,s,bv] = this._rgbToHsb(r,g,b);
    this.h = h; this.s = s * 100; this.b = bv * 100;
    this._redrawAndEmit();
  }

  toHex() {
    const [r,g,b] = this._hsbToRgb(this.h, this.s/100, this.b/100);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  toRgba() {
    const [r,g,b] = this._hsbToRgb(this.h, this.s/100, this.b/100);
    return `rgba(${r},${g},${b},${this.a/100})`;
  }

  getState() {
    return { h: this.h, s: this.s, b: this.b, a: this.a, hex: this.toHex(), rgba: this.toRgba() };
  }

  addToHistory(hex) {
    if (this.history[0] === hex) return;
    this.history.unshift(hex);
    if (this.history.length > this.maxHistory) this.history.pop();
  }

  getHarmony() {
    const h = this.h;
    switch (this.harmonyMode) {
      case 'complementary': return [h, (h + 180) % 360];
      case 'analogous': return [(h - 30 + 360) % 360, h, (h + 30) % 360];
      case 'triadic': return [h, (h + 120) % 360, (h + 240) % 360];
      default: return [h];
    }
  }

  _renderHarmonyColor(hue) {
    const [r,g,b] = this._hsbToRgb(hue, this.s/100, this.b/100);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  getHarmonyColors() {
    return this.getHarmony().map(h => this._renderHarmonyColor(h));
  }

  // ── Color Math ──

  _hsbToRgb(h, s, b) {
    if (s === 0) {
      const v = Math.round(b * 255);
      return [v, v, v];
    }
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = b * (1 - s);
    const q = b * (1 - f * s);
    const t = b * (1 - (1 - f) * s);
    let r, g, bl;
    switch (i) {
      case 0: r=b; g=t; bl=p; break;
      case 1: r=q; g=b; bl=p; break;
      case 2: r=p; g=b; bl=t; break;
      case 3: r=p; g=q; bl=b; break;
      case 4: r=t; g=p; bl=b; break;
      default: r=b; g=p; bl=q; break;
    }
    return [Math.round(r*255), Math.round(g*255), Math.round(bl*255)];
  }

  _rgbToHsb(r, g, b) {
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const diff = max - min;
    let h = 0, s = max === 0 ? 0 : diff / max, bv = max;
    if (diff !== 0) {
      if (max === r) h = ((g - b) / diff + 6) % 6;
      else if (max === g) h = (b - r) / diff + 2;
      else h = (r - g) / diff + 4;
      h *= 60;
    }
    return [h, s, bv];
  }
}
