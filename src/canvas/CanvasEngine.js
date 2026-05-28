/**
 * CanvasEngine — Core rendering system
 * - Multi-Page Artboards
 * - Professional Selection & Transformation
 * - 60fps compositing
 */
export class CanvasEngine {
  constructor(mainCanvas, overlayCanvas) {
    this.main = mainCanvas;
    this.overlay = overlayCanvas;
    this.ctx = mainCanvas.getContext('2d', { willReadFrequently: false, alpha: true });
    this.octx = overlayCanvas.getContext('2d', { willReadFrequently: false, alpha: true });

    // Viewport transform
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;
    this.rotation = 0;

    // Canvas document size
    this.docWidth = 2048;
    this.docHeight = 2048;

    // Multi-Page Artboards
    this.artboards = [];
    this.activeArtboardIndex = 0;
    
    // Selection State
    this.selection = {
      active: false,
      maskCanvas: null,
      bufferCanvas: null,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      pivot: { x: 0, y: 0 }
    };
    this.selectionOffset = 0;

    // Global Settings
    this.gridEnabled = false;
    this.gridSize = 50;
    this.gridColor = 'rgba(255, 255, 255, 0.04)';
    this.activeRulers = [];
    this.dirty = true;
    this._animId = null;

    this._init();
  }

  _init() {
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // Create initial artboard
    this.artboards.push(this._createArtboard('Page 1'));
    this._centerCanvas();
    this._startLoop();
  }

  _resize() {
    const container = this.main.parentElement;
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    [this.main, this.overlay].forEach(c => {
      c.width = w * dpr;
      c.height = h * dpr;
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    });

    this.ctx.scale(dpr, dpr);
    this.octx.scale(dpr, dpr);
    this.dpr = dpr;
    this.viewW = w;
    this.viewH = h;
    this.dirty = true;
  }

  _centerCanvas() {
    this.offsetX = (this.viewW - this.docWidth * this.scale) / 2;
    this.offsetY = (this.viewH - this.docHeight * this.scale) / 2;
  }

  _startLoop() {
    const loop = () => {
      if (this.dirty) {
        this._composite();
        this.dirty = false;
      }
      this._animId = requestAnimationFrame(loop);
    };
    this._animId = requestAnimationFrame(loop);
  }

  setStrokeCanvas(sc) { this._activeStrokeCanvas = sc; }

  _composite() {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, w, h);

    this._drawCheckerboard(ctx, w, h);
    
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    if (this.rotation) {
      ctx.translate(this.docWidth / 2, this.docHeight / 2);
      ctx.rotate(this.rotation);
      ctx.translate(-this.docWidth / 2, -this.docHeight / 2);
    }

    // Canvas Background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.docWidth, this.docHeight);

    // Draw active artboard layers
    this._drawLayers(ctx);

    // Live stroke preview
    const activeStroke = this._brushRef?.strokeCanvas || this._activeStrokeCanvas;
    if (activeStroke) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(activeStroke, 0, 0);
    }

    ctx.restore();
    
    // Animate selection offset
    if (this.selection.active) {
      this.selectionOffset = (this.selectionOffset + 0.5) % 10;
      this.markDirty();
    }

    if (this.gridEnabled) this._drawGrid(ctx, w, h);
    this._drawRulers(ctx);
    
    // -- Draw Brush Guides (Perspective/Symmetry) --
    if (this._brushRef?.guides) {
      this._brushRef.guides.drawGuides(ctx);
    }
  }

  _drawLayers(ctx) {
    const artboard = this.getActiveArtboard();
    if (!artboard) return;

    artboard.layers.forEach(layer => {
      if (!layer.visible) return;
      ctx.globalAlpha = layer.opacity || 1;
      ctx.globalCompositeOperation = layer.blendMode || 'source-over';
      ctx.drawImage(layer.canvas, 0, 0);
    });

    // Selection Preview
    if (this.selection.active && this.selection.bufferCanvas) {
      ctx.save();
      ctx.translate(this.selection.transform.x, this.selection.transform.y);
      ctx.rotate(this.selection.transform.rotation);
      ctx.scale(this.selection.transform.scale, this.selection.transform.scale);
      ctx.drawImage(this.selection.bufferCanvas, -this.selection.pivot.x, -this.selection.pivot.y);
      
      // Draw Marching Ants border
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -this.selectionOffset;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(-this.selection.pivot.x, -this.selection.pivot.y, this.selection.bufferCanvas.width, this.selection.bufferCanvas.height);
      
      ctx.lineDashOffset = -this.selectionOffset + 5;
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(-this.selection.pivot.x, -this.selection.pivot.y, this.selection.bufferCanvas.width, this.selection.bufferCanvas.height);
      
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  _drawCheckerboard(ctx, w, h) {
    if (!this._checkerPattern) {
      const pCnv = document.createElement('canvas');
      pCnv.width = 32; pCnv.height = 32;
      const pCtx = pCnv.getContext('2d');
      pCtx.fillStyle = '#252525';
      pCtx.fillRect(0,0,32,32);
      pCtx.fillStyle = '#2A2A2A';
      pCtx.fillRect(0,0,16,16);
      pCtx.fillRect(16,16,16,16);
      this._checkerPattern = ctx.createPattern(pCnv, 'repeat');
    }
    
    ctx.save();
    ctx.fillStyle = this._checkerPattern;
    // Align pattern with canvas panning
    ctx.translate(this.offsetX % 32, this.offsetY % 32);
    ctx.fillRect(-32, -32, w + 64, h + 64);
    ctx.restore();
  }

  _drawGrid(ctx, w, h) {
    const size = this.gridSize * this.scale;
    const dx = this.offsetX % size;
    const dy = this.offsetY % size;
    ctx.save();
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = dx; x <= w; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = dy; y <= h; y += size) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    ctx.restore();
  }

  // ── Artboard & Layer Management ──
  _createArtboard(name) {
    const ab = {
      id: Math.random().toString(36).substr(2, 9),
      name: name,
      layers: [],
      activeLayerIndex: 0
    };
    this._addLayerToArtboard(ab, 'Layer 1', true);
    return ab;
  }

  deleteArtboard(index) {
    if (this.artboards.length <= 1) return false;
    this.artboards.splice(index, 1);
    // Adjust active index
    if (this.activeArtboardIndex >= this.artboards.length) {
      this.activeArtboardIndex = this.artboards.length - 1;
    }
    this.dirty = true;
    return true;
  }

  renameArtboard(index, newName) {
    if (this.artboards[index]) {
      this.artboards[index].name = newName;
      return true;
    }
    return false;
  }

  _addLayerToArtboard(ab, name, whiteFill = false) {
    const canvas = new OffscreenCanvas(this.docWidth, this.docHeight);
    const ctx = canvas.getContext('2d');
    if (whiteFill) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.docWidth, this.docHeight); }
    ab.layers.push({ name, canvas, ctx, visible: true, locked: false, opacity: 1, id: Date.now() });
  }

  // ── History / Snapshots ──
  snapshot() {
    const layer = this.getActiveLayer();
    if (!layer) return null;
    const snap = new OffscreenCanvas(this.docWidth, this.docHeight);
    snap.getContext('2d').drawImage(layer.canvas, 0, 0);
    return snap;
  }

  restoreSnapshot(snap) {
    const layer = this.getActiveLayer();
    if (!layer || !snap) return;
    layer.ctx.clearRect(0, 0, this.docWidth, this.docHeight);
    layer.ctx.drawImage(snap, 0, 0);
    this.dirty = true;
  }

  getActiveArtboard() { return this.artboards[this.activeArtboardIndex]; }
  getActiveLayer() {
    const ab = this.getActiveArtboard();
    return ab?.layers[ab.activeLayerIndex];
  }
  getActiveCtx() {
    return this.getActiveLayer()?.ctx;
  }

  get layers() {
    return this.getActiveArtboard()?.layers || [];
  }

  get activeLayerIndex() {
    return this.getActiveArtboard()?.activeLayerIndex || 0;
  }

  set activeLayerIndex(val) {
    const ab = this.getActiveArtboard();
    if (ab) {
      ab.activeLayerIndex = val;
      this.dirty = true;
    }
  }

  addPage(name) {
    this.artboards.push(this._createArtboard(name || `Page ${this.artboards.length + 1}`));
    this.activeArtboardIndex = this.artboards.length - 1;
    this.dirty = true;
  }

  switchPage(index) {
    if (index >= 0 && index < this.artboards.length) {
      this.activeArtboardIndex = index;
      this.dirty = true;
    }
  }

  addLayer(name = 'Layer') {
    const ab = this.getActiveArtboard();
    if (!ab) return;
    this._addLayerToArtboard(ab, name);
    ab.activeLayerIndex = ab.layers.length - 1;
    this.dirty = true;
  }

  deleteLayer(index) {
    const ab = this.getActiveArtboard();
    if (!ab || ab.layers.length <= 1) return;
    ab.layers.splice(index, 1);
    if (ab.activeLayerIndex >= ab.layers.length) {
      ab.activeLayerIndex = ab.layers.length - 1;
    }
    this.dirty = true;
  }

  moveLayer(from, to) {
    const ab = this.getActiveArtboard();
    if (!ab) return;
    const layer = ab.layers.splice(from, 1)[0];
    ab.layers.splice(to, 0, layer);
    this.dirty = true;
  }

  duplicateLayer(index) {
    const ab = this.getActiveArtboard();
    if (!ab || !ab.layers[index]) return;
    const original = ab.layers[index];
    const canvas = new OffscreenCanvas(this.docWidth, this.docHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(original.canvas, 0, 0);
    const copy = { ...original, name: `${original.name} Copy`, canvas, ctx, id: Date.now() };
    ab.layers.splice(index + 1, 0, copy);
    this.dirty = true;
  }

  getLayerById(id) {
    for (const ab of this.artboards) {
      const l = ab.layers.find(ly => ly.id === id);
      if (l) return l;
    }
    return null;
  }

  setDocumentSize(w, h) {
    this.docWidth = w;
    this.docHeight = h;
    // Note: This would typically require resizing all existing layers
    // For now we'll just update the doc dimensions for new layers
    this._centerCanvas();
    this.dirty = true;
  }

  // ── Selection Logic ──
  createSelection(points) {
    const layer = this.getActiveLayer();
    if (!layer || points.length < 3) return;

    // Mask
    const mask = new OffscreenCanvas(this.docWidth, this.docHeight);
    const mctx = mask.getContext('2d');
    mctx.beginPath();
    mctx.moveTo(points[0].x, points[0].y);
    points.forEach(p => mctx.lineTo(p.x, p.y));
    mctx.closePath();
    mctx.fill();

    // Copy pixels
    const buffer = new OffscreenCanvas(this.docWidth, this.docHeight);
    const bctx = buffer.getContext('2d');
    bctx.drawImage(mask, 0, 0);
    bctx.globalCompositeOperation = 'source-in';
    bctx.drawImage(layer.canvas, 0, 0);

    // Clear source
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.drawImage(mask, 0, 0);
    layer.ctx.restore();

    this.selection = {
      active: true,
      maskCanvas: mask,
      bufferCanvas: buffer,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      pivot: { x: points[0].x, y: points[0].y }
    };
    this.selection.transform.x = this.selection.pivot.x;
    this.selection.transform.y = this.selection.pivot.y;
    this.dirty = true;
  }

  commitSelection() {
    if (!this.selection.active) return;
    const layer = this.getActiveLayer();
    if (layer) {
      layer.ctx.save();
      layer.ctx.translate(this.selection.transform.x, this.selection.transform.y);
      layer.ctx.rotate(this.selection.transform.rotation);
      layer.ctx.scale(this.selection.transform.scale, this.selection.transform.scale);
      layer.ctx.drawImage(this.selection.bufferCanvas, -this.selection.pivot.x, -this.selection.pivot.y);
      layer.ctx.restore();
    }
    this.selection.active = false;
    this.dirty = true;
  }

  copySelection() {
    if (!this.selection.active) return;
    const temp = new OffscreenCanvas(this.docWidth, this.docHeight);
    temp.getContext('2d').drawImage(this.selection.bufferCanvas, 0, 0);
    this.clipboard = temp;
  }

  pasteSelection() {
    if (!this.clipboard) return;
    const buffer = new OffscreenCanvas(this.docWidth, this.docHeight);
    buffer.getContext('2d').drawImage(this.clipboard, 0, 0);
    this.selection = {
      active: true,
      maskCanvas: null, // No specific mask for pasted content
      bufferCanvas: buffer,
      transform: { x: this.docWidth / 2, y: this.docHeight / 2, scale: 1, rotation: 0 },
      pivot: { x: this.docWidth / 2, y: this.docHeight / 2 }
    };
    this.dirty = true;
  }

  clearSelection() {
    this.selection.active = false;
    this.dirty = true;
  }

  // ── Rulers & View ──
  _drawRulers(ctx) {
    if (this.activeRulers.length === 0) return;
    // ... (Implementation remains similar but simplified for core)
    this.activeRulers.forEach(r => {
      const s = this.scale, ox = this.offsetX, oy = this.offsetY;
      const x1 = r.x1 * s + ox, y1 = r.y1 * s + oy;
      const x2 = r.x2 * s + ox, y2 = r.y2 * s + oy;
      
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      
      // Update interactive handles for main.js
      r.h1 = { x: x1, y: y1 };
      r.h2 = { x: x2, y: y2 };
      r.hClose = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };

      // Draw handle visuals
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath(); ctx.arc(x1, y1, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x2, y2, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ef4444';
      ctx.beginPath(); ctx.arc(r.hClose.x, r.hClose.y, 4, 0, Math.PI * 2); ctx.fill();
    });
  }

  screenToCanvas(sx, sy) { return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale }; }
  canvasToScreen(cx, cy) { return { x: cx * this.scale + this.offsetX, y: cy * this.scale + this.offsetY }; }
  pan(dx, dy) { this.offsetX += dx; this.offsetY += dy; this.dirty = true; }
  zoomAt(cx, cy, factor) {
    const ns = Math.min(10, Math.max(0.05, this.scale * factor));
    const f = ns / this.scale;
    this.offsetX = cx - (cx - this.offsetX) * f;
    this.offsetY = cy - (cy - this.offsetY) * f;
    this.scale = ns;
    this.dirty = true;
  }
  resetView() { this.scale = 1; this._centerCanvas(); this.dirty = true; }
  
  addRuler(x1, y1, x2, y2) {
    this.activeRulers.push({ x1, y1, x2, y2 });
    this.dirty = true;
  }
  
  clearRulers() {
    this.activeRulers = [];
    this.dirty = true;
  }
  
  toggleRulers() {
    this.gridEnabled = !this.gridEnabled;
    this.dirty = true;
  }

  // ── Export & Import ──
  async exportCanvas(format = 'png', quality = 0.95) {
    const temp = document.createElement('canvas');
    temp.width = this.docWidth; temp.height = this.docHeight;
    const tctx = temp.getContext('2d');
    
    // Fill white bg for JPEGs
    if (format === 'jpeg') { tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, this.docWidth, this.docHeight); }
    this._drawLayers(tctx);

    return temp.toDataURL(`image/${format}`, quality);
  }

  async toBlob(format = 'png', quality = 0.9) {
    const temp = document.createElement('canvas');
    temp.width = this.docWidth; temp.height = this.docHeight;
    this._drawLayers(temp.getContext('2d'));
    return new Promise(resolve => temp.toBlob(resolve, `image/${format}`, quality));
  }

  importImage(src) {
    const img = new Image();
    img.onload = () => {
      const ab = this.getActiveArtboard();
      if (!ab) return;
      this.addLayer('Imported Image');
      const layer = this.getActiveLayer();
      layer.ctx.drawImage(img, 0, 0, this.docWidth, this.docHeight);
      this.dirty = true;
    };
    img.src = src;
  }

  markDirty() { this.dirty = true; }
  getOverlayCtx() { return this.octx; }
  clearOverlay() { this.octx.clearRect(0, 0, this.viewW, this.viewH); }

  setStrokeCanvas(canvas) {
    this._activeStrokeCanvas = canvas;
    this.dirty = true;
  }

  destroy() {
    cancelAnimationFrame(this._animId);
    window.removeEventListener('resize', this._resize);
  }
}
