/**
 * BrushEngine v2 — Professional multi-category brush system
 *
 * Categories:
 *  • Arabic Calligraphy  (Thuluth, Naskh, Diwani, Kufi, Ruq'a)
 *  • English Calligraphy (Copperplate, Gothic, Brush Script)
 *  • Sketch / Drawing    (Pencil HB/2B/4B, Charcoal, Pastel, Hatching)
 *  • Inking              (Fineliner, Brush Ink, Marker, Liner)
 *  • Effects             (Neon Glow, Splatter, Smoke, Stars, Glitter)
 *  • Watercolor          (Wet Wash, Dry Brush, Bleed Edge, Fan Brush)
 *
 * Core fix: stroke canvas composited ONCE on endStroke.
 * For live preview the engine reads this._strokeCanvas.
 */
import { LazyBrush } from '../utils/LazyBrush.js';
import { BrushTextures } from './BrushTextures.js';
import { GuideEngine } from './GuideEngine.js';


export class BrushEngine {
  constructor(canvasEngine) {
    this.engine = canvasEngine;

    // ── Active settings ──
    this.settings = {
      size:          20,
      opacity:       1.0,
      flow:          0.85,
      hardness:      0.85,
      spacing:       0.18,
      smoothing:     0.45,   // Pro smoothing weight
      streamline:    0.25,   // Lazy radius (0-1 mapped to px)
      silkWeight:    0.3,    // 0-1 (SilkStroke intensity)
      silkDampening: 0.15,   // 0-1 (SilkStroke speed dampening)
      velocityTaper: 0.2,    // 0-1 (Thinning effect)
      pressureSize:  true,
      pressureOpacity: false,
      jitter:        0,
      angle:         0,      // brush angle in degrees (calligraphy)
      aspectRatio:   1,      // width/height ratio (flat nib = 0.15)
      wetness:       0,      // watercolor wetness 0–1
      scatter:       0,      // particle scatter radius
      preset:        'pencil-hb',
      category:      'sketch',
      
      // -- Texture & Grain (Brush Engine 2.0) --
      shape:         'round',    // 'round', 'nib', 'flat', 'splatter'
      grain:         'noise',    // 'noise', 'canvas', 'gritty', 'smooth'
      grainScale:    1.0,        // 0.1 to 5.0
      grainBrightness: 0,        // -100 to 100
    };

    // Guide Engine (Perspective & Symmetry)
    this.guides = new GuideEngine(canvasEngine);

    // Professional Stabilizer State
    this.lazyBrush = new LazyBrush(0);
    this._smoothX = 0;
    this._smoothY = 0;

    this._color = '#000000';
    this._lastX = 0; this._lastY = 0; this._lastP = 0.5;
    this._accumulated = 0;
    this._stabBuf = [];

    // ── Gradient ──
    this.gradientMode   = false;        // on/off
    this.gradientType   = 'distance';   // 'distance' or 'position' or 'directional'
    this.gradientColorA = '#ff6b35';    // start color
    this.gradientColorB = '#7b2fff';    // end color
    this.gradientLength = 600;          // px until full transition (adjustable)
    this.gradientAngle  = 0;            // directional shading angle
    this._totalStrokeDist = 0;          // accumulated distance this stroke
    this._strokeStartX = 0;
    this._strokeStartY = 0;

    // Stroke canvas — only committed on endStroke
    this._strokeCanvas = new OffscreenCanvas(1, 1);
    this._sctx = this._strokeCanvas.getContext('2d');
    this._strokeActive = false;
  }

  // ── Color ──
  setColor(hex) { this._color = hex; }
  get color()   { return this._color; }

  // ── Resizes stroke canvas to match doc ──
  _ensureStrokeCanvas() {
    const { docWidth: w, docHeight: h } = this.engine;
    if (this._strokeCanvas.width !== w || this._strokeCanvas.height !== h) {
      this._strokeCanvas = new OffscreenCanvas(w, h);
      this._sctx = this._strokeCanvas.getContext('2d');
    }
  }

  // ── Expose stroke canvas to engine for live preview ──
  get strokeCanvas() { return this._strokeActive ? this._strokeCanvas : null; }

  // ════════════════════════════════
  //  STROKE LIFECYCLE
  // ════════════════════════════════
  beginStroke(x, y, pressure = 0.5) {
    this.lazyBrush.setRadius(this.settings.streamline * 120); // up to 120px string
    this.lazyBrush.reset(x, y);
    this._smoothX = x;
    this._smoothY = y;

    this._lastX = x; this._lastY = y; this._lastP = pressure;
    this._accumulated = 0;
    this._totalStrokeDist = 0;
    this._vX = 0; this._vY = 0; // SilkStroke 2.0 velocity
    this._strokeStartX = x;
    this._strokeStartY = y;
    this._stabBuf = [];
    this._pathHistory = [];
    this._strokeActive = true;
    this._ensureStrokeCanvas();
  }

  continueStroke(rawX, rawY, pressure = 0.5, speed = 0, mode = 'brush') {
    // ── Professional Triple-Stage Stabilization ──
    
    // Stage 1: Lazy Radius (Streamline)
    this.lazyBrush.update(rawX, rawY);
    let targetX = this.lazyBrush.x;
    let targetY = this.lazyBrush.y;

    // Stage 2: SilkStroke (Weighted Moving Average)
    // Adds physical "mass" to the brush.
    if (this.settings.silkWeight > 0) {
      this._stabBuf.push({ x: targetX, y: targetY });
      if (this._stabBuf.length > 8) this._stabBuf.shift();
      
      let sumX = 0, sumY = 0, totalW = 0;
      this._stabBuf.forEach((p, i) => {
        const w = (i + 1) / this._stabBuf.length;
        sumX += p.x * w; sumY += p.y * w; totalW += w;
      });
      targetX = sumX / totalW;
      targetY = sumY / totalW;
    }

    // Stage 3: silkStroke 2.0 (Physical Mass & Drag)
    const mass = 1 + (this.settings.silkWeight * 15);
    const drag = 0.1 + (this.settings.silkWeight * 0.4);
    
    const accX = (targetX - this._smoothX) / mass;
    const accY = (targetY - this._smoothY) / mass;
    
    this._vX = (this._vX || 0) * (1 - drag) + accX;
    this._vY = (this._vY || 0) * (1 - drag) + accY;
    
    this._smoothX += this._vX;
    this._smoothY += this._vY;
    
    // -- Guide Projection --
    const projected = this.guides.project(this._smoothX, this._smoothY);
    const x = projected.x;
    const y = projected.y;

    // ── Sub-Point Interpolation (Catmull-Rom) ──
    // We keep a small history for spline calculation.
    if (!this._pathHistory) this._pathHistory = [];
    this._pathHistory.push({ x, y, p: pressure });
    if (this._pathHistory.length > 4) this._pathHistory.shift();

    const dx = x - this._lastX, dy = y - this._lastY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.2) return;

    // If we have enough points for a spline (3+), use it for the last segment
    const useSpline = this._pathHistory.length >= 4;
    
    const size    = this._calcSize(pressure, speed);
    const spacing = Math.max(0.3, size * Math.max(0.02, this.settings.spacing));
    let walked = this._accumulated;

    while (walked + spacing <= dist) {
      walked += spacing;
      const t = walked / dist;
      
      let sx, sy, sp;
      if (useSpline) {
        // Catmull-Rom interpolation on the segment [P\[1\], P\[2\]]
        const p0 = this._pathHistory[0], p1 = this._pathHistory[1], p2 = this._pathHistory[2], p3 = this._pathHistory[3];
        sx = this._catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        sy = this._catmullRom(p0.y, p1.y, p2.y, p3.y, t);
        sp = this._catmullRom(p0.p, p1.p, p2.p, p3.p, t);
      } else {
        sx = this._lastX + (x - this._lastX) * t;
        sy = this._lastY + (y - this._lastY) * t;
        sp = this._lastP + (pressure - this._lastP) * t;
      }

      const ss = this._calcSize(sp, speed);
      const nx = dx / dist, ny = dy / dist; // approximation for direction

      // Gradient progress calculation
      let gProgress = 0;
      if (this.gradientType === 'position') {
        // Calculate based on distance from start point, oscillating
        const maxDist = this.gradientLength;
        const dxFromStart = sx - this._strokeStartX;
        const dyFromStart = sy - this._strokeStartY;
        // Directional distance (e.g., primarily horizontal or vertical)
        const distFromStart = Math.hypot(dxFromStart, dyFromStart);
        // Map to 0..1..0 oscillating based on length
        gProgress = (Math.sin(distFromStart / maxDist * Math.PI) + 1) / 2;
      } else if (this.gradientType === 'directional') {
        const rad = this.gradientAngle * Math.PI / 180;
        const lx = Math.cos(rad);
        const ly = Math.sin(rad);
        const dot = nx * lx + ny * ly; // -1 to 1 depending on stroke direction
        gProgress = (dot + 1) / 2;     // mapped to 0 to 1
      } else {
        // Base distance calculation (ping-pong effect over accumulated distance)
        const cycleLength = Math.max(1, this.gradientLength) * 2;
        const mappedDist = this._totalStrokeDist % cycleLength;
        gProgress = mappedDist < this.gradientLength 
          ? mappedDist / this.gradientLength 
          : 1 - ((mappedDist - this.gradientLength) / this.gradientLength);
      }

      switch (mode) {
        case 'eraser':  this._stampEraser(sx, sy, ss); break;
        case 'smudge':  this._stampSmudge(sx, sy, ss, sp); break;
        default:        this._stamp(sx, sy, ss, sp, speed, nx, ny, gProgress); break;
      }
    }

    this._totalStrokeDist += dist;
    this._accumulated = walked - dist;
    this._lastX = x; this._lastY = y; this._lastP = pressure;
    this.engine.markDirty();
  }

  endStroke(mode = 'brush') {
    if (!this._strokeActive) return;
    this._strokeActive = false;

    if (mode !== 'eraser' && mode !== 'smudge') {
      // Commit stroke canvas → active layer ONCE
      const lctx = this.engine.getActiveCtx();
      if (lctx) {
        lctx.drawImage(this._strokeCanvas, 0, 0);
        this._sctx.clearRect(0, 0, this._strokeCanvas.width, this._strokeCanvas.height);
      }
    }
    this.engine.markDirty();
  }

  // ════════════════════════════════
  //  MAIN STAMP DISPATCHER
  // ════════════════════════════════
  _stamp(x, y, size, pressure, speed, nx, ny, gProgress = 0) {
    const ctx = this._sctx;
    
    // ── Apply gradient color ──
    if (this.gradientMode) {
      this._color = this._lerpHex(this.gradientColorA, this.gradientColorB, gProgress);
    }

    // Update tip cache if needed
    this._updateBrushTip(size, this._color);

    // Alpha calculation
    const alpha = this._calcAlpha(pressure);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = this.settings.composite || 'source-over';

    // Jitter & Scatter
    let rx = x, ry = y;
    if (this.settings.jitter > 0 || this.settings.scatter > 0) {
      const j = this.settings.jitter * size * 0.5;
      const s = this.settings.scatter * size * 2.0;
      rx += (Math.random() - 0.5) * (j + s);
      ry += (Math.random() - 0.5) * (j + s);
    }

    // -- Symmetry Loop --
    const symPoints = this.guides.getSymmetryPoints(rx, ry);
    const half = size / 2;

    symPoints.forEach(pt => {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      if (this.settings.aspectRatio !== 1) {
        ctx.rotate(Math.atan2(ny, nx) + (this.settings.angle * Math.PI / 180));
      }
      ctx.drawImage(this._cachedTip, -half, -half, size, size);
      ctx.restore();
    });
    
    ctx.globalAlpha = 1.0;
  }

  /**
   * Generates and caches a high-quality textured brush tip
   */
  _updateBrushTip(size, color) {
    const s = this.settings;
    const roundedSize = Math.max(1, Math.ceil(size));
    
    // Check if cache is still valid
    if (this._cachedTip && 
        this._cachedTipSize === roundedSize && 
        this._cachedColor === color && 
        this._cachedHardness === s.hardness &&
        this._cachedShape === s.shape &&
        this._cachedGrain === s.grain) {
      return;
    }

    // Create new cache canvas
    const tip = new OffscreenCanvas(roundedSize, roundedSize);
    const tctx = tip.getContext('2d');

    // 1. Generate Shape
    const shapeSurface = BrushTextures.generateShape(s.shape, roundedSize, {
      hardness: s.hardness,
      angle: 0, // direction is handled in _stamp rotation
      aspectRatio: s.aspectRatio
    });

    // 2. Generate Grain
    const grainSurface = BrushTextures.generateGrain(s.grain, roundedSize);

    // 3. Composite Shape into Grain
    tctx.drawImage(shapeSurface, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.drawImage(grainSurface, 0, 0);

    // 4. Colorize
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, roundedSize, roundedSize);

    this._cachedTip = tip;
    this._cachedTipSize = roundedSize;
    this._cachedColor = color;
    this._cachedHardness = s.hardness;
    this._cachedShape = s.shape;
    this._cachedGrain = s.grain;
  }

  // ════════════════════════════════
  //  STAMP IMPLEMENTATIONS
  // ════════════════════════════════


  // ── Eraser ──
  _stampEraser(x, y, size) {
    const lctx = this.engine.getActiveCtx();
    if (!lctx) return;
    const r = size / 2;
    const alpha = Math.min(1, this.settings.flow * this.settings.opacity);
    const grd = lctx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0,                   `rgba(0,0,0,${alpha})`);
    grd.addColorStop(this.settings.hardness, `rgba(0,0,0,${alpha * 0.4})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.globalCompositeOperation = 'destination-out';
    lctx.fillStyle = grd;
    lctx.beginPath();
    lctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    lctx.fill();
    lctx.globalCompositeOperation = 'source-over';
    this.engine.markDirty();
  }

  // ── Smudge ──
  _stampSmudge(x, y, size, pressure) {
    const lctx = this.engine.getActiveCtx();
    if (!lctx) return;
    const r   = size / 2;
    const str = 0.55 * pressure;
    const sample = lctx.getImageData(x - r, y - r, size * 2, size * 2);
    const tmp = new OffscreenCanvas(size * 2, size * 2);
    tmp.getContext('2d').putImageData(sample, 0, 0);
    lctx.globalAlpha = str;
    lctx.drawImage(tmp, x - r + 2, y - r + 2, size * 2, size * 2);
    lctx.globalAlpha = 1;
    this.engine.markDirty();
  }

  // ════════════════════════════════
  //  PRESETS CATALOG
  // ════════════════════════════════
  static get CATALOG() {
    return {
      // Arabic Calligraphy
      'arabic-thuluth':  { label: 'ثلث',       emoji: '✒️', category: 'arabic',    size: 28, opacity: 1,    flow: 1,    hardness: 1,    spacing: 0.06, smoothing: 0.7,  pressureSize: true,  pressureOpacity: false, angle: 45,  aspectRatio: 0.13, jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#1a1a2e' },
      'arabic-naskh':    { label: 'نسخ',       emoji: '🖊️', category: 'arabic',    size: 18, opacity: 1,    flow: 1,    hardness: 1,    spacing: 0.06, smoothing: 0.7,  pressureSize: true,  pressureOpacity: false, angle: 30,  aspectRatio: 0.18, jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#0d1b2a' },
      'arabic-diwani':   { label: 'ديواني',    emoji: '✍️', category: 'arabic',    size: 22, opacity: 0.95, flow: 0.95, hardness: 0.9,  spacing: 0.07, smoothing: 0.65, pressureSize: true,  pressureOpacity: true,  angle: 20,  aspectRatio: 0.22, jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#2d1b69' },
      'arabic-kufi':     { label: 'كوفي',      emoji: '🖌️', category: 'arabic',    size: 24, opacity: 1,    flow: 1,    hardness: 1,    spacing: 0.05, smoothing: 0.8,  pressureSize: false, pressureOpacity: false, angle: 0,   aspectRatio: 0.12, jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#1a1a2e' },
      'arabic-ruqa':     { label: 'رقعة',      emoji: '📝', category: 'arabic',    size: 16, opacity: 1,    flow: 1,    hardness: 0.95, spacing: 0.07, smoothing: 0.6,  pressureSize: true,  pressureOpacity: false, angle: 15,  aspectRatio: 0.2,  jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#16213e' },
      'arabic-modern':   { label: 'Modern Arabic', emoji: '🌙', category: 'arabic', size: 20, opacity: 0.95, flow: 0.92, hardness: 0.88, spacing: 0.08, smoothing: 0.72, pressureSize: true,  pressureOpacity: true,  angle: 35,  aspectRatio: 0.16, jitter: 0,   shape: 'nib',      grain: 'smooth', previewColor: '#6c3483' },

      // English Calligraphy
      'english-calli-copperplate': { label: 'Copperplate',  emoji: '🖋️', category: 'calligraphy', size: 12, opacity: 1,    flow: 1,    hardness: 1,    spacing: 0.06, smoothing: 0.75, pressureSize: true,  pressureOpacity: false, angle: 55, aspectRatio: 0.12, jitter: 0, previewColor: '#2c3e50' },
      'english-calli-gothic':      { label: 'Gothic',       emoji: '✒️', category: 'calligraphy', size: 22, opacity: 1,    flow: 1,    hardness: 1,    spacing: 0.05, smoothing: 0.7,  pressureSize: false, pressureOpacity: false, angle: 45, aspectRatio: 0.14, jitter: 0, previewColor: '#1a1a2e' },
      'english-calli-brush':       { label: 'Brush Script', emoji: '🖌️', category: 'calligraphy', size: 20, opacity: 0.95, flow: 0.9,  hardness: 0.85, spacing: 0.07, smoothing: 0.65, pressureSize: true,  pressureOpacity: true,  angle: 15, aspectRatio: 0.28, jitter: 0, previewColor: '#154360' },

      // Sketch / Drawing
      'pencil-hb':  { label: 'Pencil HB',  emoji: '✏️', category: 'sketch', size: 7,  opacity: 0.8,  flow: 0.85, hardness: 0.5, spacing: 0.1,  smoothing: 0.35, pressureSize: true, pressureOpacity: true,  jitter: 0.1,  angle: 0, aspectRatio: 1,   shape: 'round',    grain: 'noise',  previewColor: '#4a4a4a' },
      'pencil-2b':  { label: 'Pencil 2B',  emoji: '✏️', category: 'sketch', size: 10, opacity: 0.85, flow: 0.9,  hardness: 0.4, spacing: 0.1,  smoothing: 0.3,  pressureSize: true, pressureOpacity: true,  jitter: 0.15, angle: 0, aspectRatio: 1,   shape: 'round',    grain: 'noise',  previewColor: '#2c2c2c' },
      'pencil-4b':  { label: 'Pencil 4B',  emoji: '✏️', category: 'sketch', size: 14, opacity: 0.9,  flow: 0.95, hardness: 0.3, spacing: 0.1,  smoothing: 0.25, pressureSize: true, pressureOpacity: true,  jitter: 0.2,  angle: 0, aspectRatio: 1,   shape: 'round',    grain: 'noise',  previewColor: '#1a1a1a' },
      'charcoal':   { label: 'Charcoal',   emoji: '🩶', category: 'sketch', size: 30, opacity: 0.7,  flow: 0.7,  hardness: 0.3, spacing: 0.08, smoothing: 0.3,  pressureSize: true, pressureOpacity: true,  jitter: 0.4,  angle: 0, aspectRatio: 1.2, shape: 'splatter', grain: 'gritty', previewColor: '#3d3d3d' },
      'pastel':     { label: 'Pastel',     emoji: '🎨', category: 'sketch', size: 25, opacity: 0.6,  flow: 0.6,  hardness: 0.2, spacing: 0.1,  smoothing: 0.4,  pressureSize: true, pressureOpacity: false, jitter: 0.3,  angle: 0, aspectRatio: 1,   shape: 'splatter', grain: 'canvas', previewColor: '#7d3c98' },
      'graphite':   { label: 'Graphite',   emoji: '🔲', category: 'sketch', size: 12, opacity: 0.75, flow: 0.8,  hardness: 0.7, spacing: 0.06, smoothing: 0.45, pressureSize: true, pressureOpacity: true,  jitter: 0.05, angle: 20,aspectRatio: 0.4, shape: 'nib',      grain: 'noise',  previewColor: '#555555' },
      'oil-paint':  { label: 'Oil Paint',  emoji: '🎨', category: 'sketch', size: 28, opacity: 0.92, flow: 0.88, hardness: 0.75,spacing: 0.07, smoothing: 0.55, pressureSize: true, pressureOpacity: true,  jitter: 0.1,  angle: 0, aspectRatio: 1,   shape: 'flat',     grain: 'canvas', previewColor: '#1a5276' },
      'gouache':    { label: 'Gouache',    emoji: '🖍️', category: 'sketch', size: 22, opacity: 0.95, flow: 0.92, hardness: 0.85,spacing: 0.06, smoothing: 0.5,  pressureSize: true, pressureOpacity: false, jitter: 0.05, angle: 0, aspectRatio: 1,   shape: 'flat',     grain: 'smooth', previewColor: '#6e2f8a' },

      // Inking
      'fineliner':   { label: 'Fineliner',  emoji: '🖊️', category: 'ink', size: 3,  opacity: 1,    flow: 1,    hardness: 1,   spacing: 0.04, smoothing: 0.55, pressureSize: false, pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#1c2833', wetness: 0 },
      'brush-ink':   { label: 'Brush Ink',  emoji: '🖌️', category: 'ink', size: 18, opacity: 1,    flow: 1,    hardness: 0.9, spacing: 0.06, smoothing: 0.6,  pressureSize: true,  pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#17202a', wetness: 0 },
      'marker':      { label: 'Marker',     emoji: '🖍️', category: 'ink', size: 35, opacity: 0.88, flow: 0.85, hardness: 0.95,spacing: 0.08, smoothing: 0.3,  pressureSize: false, pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'flat',     grain: 'smooth', previewColor: '#1a5276', wetness: 0 },
      'liner':       { label: 'Liner',      emoji: '✒️', category: 'ink', size: 2,  opacity: 1,    flow: 1,    hardness: 1,   spacing: 0.04, smoothing: 0.65, pressureSize: false, pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#000000', wetness: 0 },

      // Watercolor
      'watercolor-wet':  { label: 'Wet Wash',   emoji: '💧', category: 'watercolor', size: 55, opacity: 0.35, flow: 0.3,  hardness: 0,   spacing: 0.12, smoothing: 0.55, pressureSize: true, pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'round', grain: 'noise',  previewColor: '#5dade2', wetness: 0.8  },
      'watercolor-dry':  { label: 'Dry Brush',  emoji: '🖌️', category: 'watercolor', size: 38, opacity: 0.5,  flow: 0.45, hardness: 0,   spacing: 0.1,  smoothing: 0.35, pressureSize: true, pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'round', grain: 'canvas', previewColor: '#a9cce3', wetness: 0.15 },
      'bleed':           { label: 'Bleed Edge', emoji: '🎨', category: 'watercolor', size: 45, opacity: 0.3,  flow: 0.28, hardness: 0,   spacing: 0.14, smoothing: 0.6,  pressureSize: true, pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round', grain: 'noise',  previewColor: '#7fb3d3', wetness: 1.0  },
      'watercolor-fan':  { label: 'Fan Brush',  emoji: '🪭', category: 'watercolor', size: 50, opacity: 0.4,  flow: 0.35, hardness: 0,   spacing: 0.09, smoothing: 0.4,  pressureSize: true, pressureOpacity: true,  jitter: 8, angle: 0, aspectRatio: 1, shape: 'round', grain: 'canvas', previewColor: '#85c1e9', wetness: 0.5  },

      // Effects
      'neon':           { label: 'Neon Glow',     emoji: '💡', category: 'effects', size: 22, opacity: 0.9,  flow: 0.85, hardness: 0, spacing: 0.1,  smoothing: 0.5, pressureSize: true,  pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#00ffcc', composite: 'lighter' },
      'splatter':       { label: 'Splatter',      emoji: '💦', category: 'effects', size: 30, opacity: 0.85, flow: 0.8,  hardness: 0, spacing: 0.2,  smoothing: 0.2, pressureSize: true,  pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'splatter', grain: 'noise',  previewColor: '#2980b9' },
      'smoke':          { label: 'Smoke',         emoji: '💨', category: 'effects', size: 60, opacity: 0.6,  flow: 0.5,  hardness: 0, spacing: 0.15, smoothing: 0.7, pressureSize: true,  pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'noise',  previewColor: '#7f8c8d' },
      'stars':          { label: 'Stars',         emoji: '⭐', category: 'effects', size: 35, opacity: 0.95, flow: 0.9,  hardness: 0, spacing: 0.18, smoothing: 0.3, pressureSize: true,  pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'splatter', grain: 'noise',  previewColor: '#f39c12' },
      'glitter':        { label: 'Glitter',       emoji: '✨', category: 'effects', size: 40, opacity: 1,    flow: 1,    hardness: 0, spacing: 0.15, smoothing: 0.2, pressureSize: true,  pressureOpacity: false, jitter: 0, angle: 0, aspectRatio: 1, shape: 'splatter', grain: 'noise',  previewColor: '#f1c40f' },
      'spray-paint':    { label: 'Spray Paint',   emoji: '🎨', category: 'effects', size: 45, opacity: 0.6,  flow: 0.55, hardness: 0, spacing: 0.05, smoothing: 0.2, pressureSize: true,  pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'splatter', grain: 'noise',  previewColor: '#8e44ad', scatter: 0.8 },
      'airbrush':       { label: 'Airbrush',      emoji: '✈️', category: 'effects', size: 50, opacity: 0.5,  flow: 0.45, hardness: 0, spacing: 0.08, smoothing: 0.6, pressureSize: true,  pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#9b59b6' },
      'airbrush-neon':  { label: 'Airbrush Neon', emoji: '🌈', category: 'effects', size: 48, opacity: 0.55, flow: 0.5,  hardness: 0, spacing: 0.08, smoothing: 0.6, pressureSize: true,  pressureOpacity: true,  jitter: 0, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#00d2ff', composite: 'lighter' },
      'stipple':        { label: 'Stipple',       emoji: '🔵', category: 'effects', size: 8,  opacity: 0.9,  flow: 0.85, hardness: 0.9,spacing: 0.5,  smoothing: 0.1, pressureSize: true,  pressureOpacity: true,  jitter: 2, angle: 0, aspectRatio: 1, shape: 'round',    grain: 'smooth', previewColor: '#2c3e50' },
    };
  }

  applyPreset(name) {
    const presets = BrushEngine.CATALOG;
    const p = presets[name];
    if (!p) return;
    Object.assign(this.settings, {
      size:           p.size,
      opacity:        p.opacity,
      flow:           p.flow,
      hardness:       p.hardness,
      spacing:        p.spacing,
      smoothing:      p.smoothing,
      pressureSize:   p.pressureSize,
      pressureOpacity:p.pressureOpacity,
      jitter:         p.jitter   ?? 0,
      angle:          p.angle    ?? 0,
      aspectRatio:    p.aspectRatio ?? 1,
      wetness:        p.wetness  ?? 0,
      scatter:        p.scatter  ?? 0,
      shape:          p.shape    ?? 'round',
      grain:          p.grain    ?? 'noise',
      composite:      p.composite ?? 'source-over',
      preset:         name,
      category:       p.category,
    });
    this._cachedTip = null; // Clear cache
  }

  // ── Setters ──
  setSize(v)      { this.settings.size      = Math.max(1, Math.min(500, v)); }
  setOpacity(v)   { this.settings.opacity   = Math.max(0.01, Math.min(1, v)); }
  setFlow(v)      { this.settings.flow      = Math.max(0.01, Math.min(1, v)); }
  setSmoothing(v) { this.settings.smoothing = Math.max(0, Math.min(1, v)); this._stabBuf = []; }
  
  setHardness(v)  { this.settings.hardness = Math.max(0, Math.min(1, v)); this._cachedTip = null; }
  setShape(v)     { this.settings.shape    = v; this._cachedTip = null; }
  setGrain(v)     { this.settings.grain    = v; this._cachedTip = null; }
  setGrainScale(v){ this.settings.grainScale = Math.max(0.1, Math.min(5, v)); this._cachedTip = null; }
  setGrainBrightness(v) { this.settings.grainBrightness = Math.max(-100, Math.min(100, v)); this._cachedTip = null; }

  // ── Gradient Mode ──
  setGradient(enabled, colorA, colorB, length, type = 'distance', angle = 0) {
    this.gradientMode   = enabled;
    if (colorA) this.gradientColorA = colorA;
    if (colorB) this.gradientColorB = colorB;
    if (length) this.gradientLength = length;
    if (type)   this.gradientType   = type;
    this.gradientAngle = angle;
  }

  /** Swap A ↔ B */
  swapGradientColors() {
    [this.gradientColorA, this.gradientColorB] = [this.gradientColorB, this.gradientColorA];
  }

  // ── Helpers ──
  _calcSize(p, speed) {
    let s = this.settings.size;
    
    // ── Velocity Taper ──
    if (this.settings.velocityTaper > 0 && speed > 0) {
      // 35px/ms is the capping threshold for max thinning
      const vFactor = Math.min(1.0, speed / 35);
      // t can go down to 20% of original size at max speed/taper
      const t = 1.0 - (vFactor * this.settings.velocityTaper * 0.85);
      s *= t;
    }

    if (this.settings.pressureSize) s *= (0.15 + Math.pow(Math.max(0.01, p), 0.55) * 0.85);
    return Math.max(0.5, s);
  }
  _calcAlpha(p) {
    const base = this.settings.opacity * this.settings.flow;
    return this.settings.pressureOpacity ? base * Math.max(0.05, p) : base;
  }
  _rgba(a) {
    const hex = this._color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
  }

  /** Interpolate between two hex colors at t ∈ [0,1] using smooth hermite curve */
  _lerpHex(hexA, hexB, t) {
    // Smooth step for more natural gradient feel
    const s = t * t * (3 - 2 * t);
    const parse = h => {
      const c = h.replace('#','');
      return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
    };
    const [r1,g1,b1] = parse(hexA);
    const [r2,g2,b2] = parse(hexB);
    const r = Math.round(r1 + (r2 - r1) * s);
    const g = Math.round(g1 + (g2 - g1) * s);
    const b = Math.round(b1 + (b2 - b1) * s);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  // ── Brush cursor preview on overlay ──
  drawCursor(x, y, pressure = 0.5) {
    const oct = this.engine.getOverlayCtx();
    this.engine.clearOverlay();
    const size = this._calcSize(pressure, 0);
    const pos  = this.engine.canvasToScreen(x, y);
    const r    = Math.max(2, (size / 2) * this.engine.scale);

    oct.beginPath();
    oct.arc(pos.x, pos.y, r, 0, Math.PI * 2);

    oct.strokeStyle = 'rgba(0,0,0,0.8)';
    oct.lineWidth = 2.5;
    oct.stroke();

    oct.strokeStyle = 'rgba(255,255,255,0.95)';
    oct.lineWidth = 1;
    oct.stroke();

    // Symmetry ghosts
    const symCursors = this.guides.getSymmetryPoints(x, y);
    if (symCursors.length > 1) {
      oct.strokeStyle = 'rgba(255,255,255,0.4)';
      oct.setLineDash([2, 4]);
      symCursors.slice(1).forEach(pt => {
        const p = this.engine.canvasToScreen(pt.x, pt.y);
        oct.beginPath();
        oct.arc(p.x, p.y, r, 0, Math.PI * 2);
        oct.stroke();
      });
      oct.setLineDash([]);
    }

    oct.fillStyle = 'rgba(255,255,255,0.95)';
    oct.beginPath();
    oct.arc(pos.x, pos.y, 1.2, 0, Math.PI * 2);
    oct.fill();
  }

  // ── Panel preview ──
  renderPreview(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#191919';
    ctx.fillRect(0, 0, w, h);

    const steps = 30;
    for (let i = 0; i < steps; i++) {
      const t  = i / (steps - 1);
      const px = w * 0.07 + t * w * 0.86;
      const py = h * 0.5 + Math.sin(t * Math.PI) * h * 0.25;
      const pr = 0.2 + Math.sin(t * Math.PI) * 0.8;
      const sz = this._calcSize(pr, 0);
      const al = this._calcAlpha(pr);

      const previewColor = this.gradientMode
        ? this._lerpHex(this.gradientColorA, this.gradientColorB, t)
        : this._color;

      this._updateBrushTip(sz, previewColor);
      ctx.globalAlpha = al;
      ctx.drawImage(this._cachedTip, px - sz/2, py - sz/2, sz, sz);
    }
    ctx.globalAlpha = 1.0;
  }
}
