/**
 * InputHandler — Unified pointer input system
 * - Mouse, touch, stylus (Pointer Events API)
 * - Pressure, tilt, velocity from pointer events
 * - Pinch-to-zoom gesture
 * - Two-finger undo
 * - Rotation gesture
 */
export class InputHandler {
  constructor(canvas, engine, onStroke) {
    this.canvas = canvas;
    this.engine = engine;
    this.onStroke = onStroke;  // callback(type, data)

    this.pointers = new Map();
    this.isDrawing = false;
    this.isPanning = false;
    this.currentStroke = null;
    this.mode = 'brush'; // brush | eraser | smudge | eyedropper | selection | lasso | pan | fill
    this.lassoPoints = [];

    // Gesture state
    this._prevPinchDist = 0;
    this._prevPinchMid = null;
    this._prevRotAngle = 0;
    this.gridSnap = false;

    // Velocity tracking
    this._lastPoint = null;
    this._lastTime = 0;

    // Long press
    this._longPressTimer = null;
    this._startPos = null;

    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', this._onDown.bind(this), { passive: false });
    c.addEventListener('pointermove', this._onMove.bind(this), { passive: false });
    c.addEventListener('pointerup', this._onUp.bind(this), { passive: false });
    c.addEventListener('pointercancel', this._onUp.bind(this), { passive: false });
    c.addEventListener('pointerleave', () => this.onStroke('hover_out', {}), { passive: false });
    c.addEventListener('wheel', this._onWheel.bind(this), { passive: false });

    // Keyboard shortcuts
    window.addEventListener('keydown', this._onKey.bind(this));
  }

  setMode(mode) { this.mode = mode; }

  _getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure > 0 ? e.pressure : 0.5,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      pointerType: e.pointerType
    };
  }

  _onDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const pos = this._getPos(e);
    this.pointers.set(e.pointerId, pos);

    // Two-pointer = gesture (pan/zoom/rotate)
    if (this.pointers.size === 2) {
      this.isDrawing = false;
      this.currentStroke = null;
      const pts = [...this.pointers.values()];
      this._prevPinchDist = this._dist(pts[0], pts[1]);
      this._prevPinchMid = this._mid(pts[0], pts[1]);
      this._prevRotAngle = this._angle(pts[0], pts[1]);
      this.onStroke('gesture_start', {});
      return;
    }

    if (this.mode === 'eyedropper') {
      this._sampleColor(pos);
      return;
    }

    if (this.mode === 'selection' || this.mode === 'lasso') {
      const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
      this._lastPoint = canvasPos;
      this.lassoPoints = [{ ...canvasPos }];
      this.onStroke('selection_start', { ...canvasPos, mode: this.mode });
      return;
    }

    // Start stroke
    this.isDrawing = true;
    const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
    this._lastPoint = canvasPos;
    this._lastTime = performance.now();

    this.currentStroke = {
      points: [canvasPos],
      pressures: [pos.pressure],
      timestamps: [this._lastTime],
      color: null, // filled by BrushEngine
      size: null,
      mode: this.mode
    };

    if (this.gridSnap) {
      const gs = this.engine.gridSize;
      canvasPos.x = Math.round(canvasPos.x / gs) * gs;
      canvasPos.y = Math.round(canvasPos.y / gs) * gs;
    }

    this.onStroke('stroke_start', {
      ...canvasPos, pressure: pos.pressure,
      pointerType: pos.pointerType, mode: this.mode
    });

    if (this.mode === 'fill') {
      const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
      this.onStroke('fill_click', { ...canvasPos });
      return;
    }

    // Start long-press timer
    this._startPos = { x: pos.x, y: pos.y };
    this._longPressTimer = setTimeout(() => {
      if (this.isDrawing && this.pointers.size === 1) {
        this.isDrawing = false; // Stop drawing if long-press triggers
        this.onStroke('long_press', { ...pos });
      }
    }, 600);

    // Start long-press timer
  }

  _onMove(e) {
    e.preventDefault();
    
    // Support high-frequency input (iPad/Wacom/Surface)
    // Only coalesce for primary drawing pointer to avoid gesture jitter
    const events = (e.getCoalescedEvents && this.pointers.size === 1) ? e.getCoalescedEvents() : [e];
    
    for (const event of events) {
      const pos = this._getPos(event);
      this.pointers.set(event.pointerId, pos);

      // Two-pointer gestures
      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        const dist = this._dist(pts[0], pts[1]);
        const mid = this._mid(pts[0], pts[1]);
        const angle = this._angle(pts[0], pts[1]);

        // Pinch zoom
        if (this._prevPinchDist > 0) {
          const zoomFactor = dist / this._prevPinchDist;
          this.engine.zoomAt(mid.x, mid.y, zoomFactor);
        }

        // Pan
        if (this._prevPinchMid) {
          this.engine.pan(mid.x - this._prevPinchMid.x, mid.y - this._prevPinchMid.y);
        }

        this._prevPinchDist = dist;
        this._prevPinchMid = mid;
        this._prevRotAngle = angle;

        this.onStroke('zoom_change', { scale: this.engine.scale });
        return; // Break out of loop since gestures only care about latest state
      }

      if (!this.isDrawing) {
        if (this.mode === 'eyedropper') {
          this._sampleColor(pos, true);
        } else if (this.mode === 'selection' || this.mode === 'lasso') {
          if (this.pointers.size === 1) {
            const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
            if (this.mode === 'lasso') {
              this.lassoPoints.push({ ...canvasPos });
              this.onStroke('selection_move', { ...canvasPos, mode: this.mode, points: this.lassoPoints });
            } else if (this.mode === 'selection' && this.engine.selection.active) {
              const dx = canvasPos.x - this._lastPoint.x;
              const dy = canvasPos.y - this._lastPoint.y;
              this.engine.selection.transform.x += dx;
              this.engine.selection.transform.y += dy;
              this._lastPoint = canvasPos;
              this.engine.markDirty();
            }
          }
        } else {
          const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
          this.onStroke('hover', { ...canvasPos, pressure: pos.pressure });
        }
        continue;
      }

      // Cancel long-press if moved significantly
      if (this._longPressTimer) {
        const dx = pos.x - this._startPos.x;
        const dy = pos.y - this._startPos.y;
        if (Math.hypot(dx, dy) > 10) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
      }

      const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
      if (this.gridSnap) {
        const gs = this.engine.gridSize;
        canvasPos.x = Math.round(canvasPos.x / gs) * gs;
        canvasPos.y = Math.round(canvasPos.y / gs) * gs;
      }
      const now = performance.now();
      const dt = now - this._lastTime;
      const dx = canvasPos.x - (this._lastPoint?.x || canvasPos.x);
      const dy = canvasPos.y - (this._lastPoint?.y || canvasPos.y);
      const speed = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;

      if (this.currentStroke) {
        this.currentStroke.points.push(canvasPos);
        this.currentStroke.pressures.push(pos.pressure);
        this.currentStroke.timestamps.push(now);
      }

      this._lastPoint = canvasPos;
      this._lastTime = now;

      this.onStroke('stroke_move', {
        ...canvasPos, pressure: pos.pressure,
        tiltX: pos.tiltX, tiltY: pos.tiltY,
        speed, pointerType: pos.pointerType
      });
    }
  }

  _onUp(e) {
    if (this.mode === 'selection' || this.mode === 'lasso') {
      this.onStroke('selection_end', { points: this.lassoPoints });
      this.isDrawing = false;
      return;
    }

    e.preventDefault();
    this.pointers.delete(e.pointerId);

    if (this.pointers.size < 2) {
      this._prevPinchDist = 0;
      this._prevPinchMid = null;
    }

    if (!this.isDrawing) return;
    this.isDrawing = false;
    clearTimeout(this._longPressTimer);
    this._longPressTimer = null;

    const pos = this._getPos(e);
    const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);

    this.onStroke('stroke_end', {
      ...canvasPos,
      stroke: this.currentStroke
    });
    this.currentStroke = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const pos = this._getPos(e);
    const delta = e.deltaY < 0 ? 1.1 : 0.9;
    this.engine.zoomAt(pos.x, pos.y, delta);
    this.onStroke('zoom_change', { scale: this.engine.scale });
  }

  _onKey(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case 'z':
      case 'Z':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) this.onStroke('redo', {});
          else this.onStroke('undo', {});
        }
        break;
      case 'y':
      case 'Y':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.onStroke('redo', {}); }
        break;
      case 'b': case 'B': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'brush' }); break;
      case 'e': case 'E': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'eraser' }); break;
      case 's': case 'S': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'smudge' }); break;
      case 'i': case 'I': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'eyedropper' }); break;
      case 'v': case 'V': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'selection' }); break;
      case 'g': case 'G': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'gradient' }); break;
      case 't': case 'T': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'text' }); break;
      case '[': { const cur = this.engine._brushRef?.settings?.size || 20; this.onStroke('brush_size', { delta: -2 }); break; }
      case ']': { this.onStroke('brush_size', { delta: 2 }); break; }
      case '+': case '=': this.engine.zoomAt(this.engine.viewW/2, this.engine.viewH/2, 1.2); this.onStroke('zoom_change', {scale: this.engine.scale}); break;
      case '-': this.engine.zoomAt(this.engine.viewW/2, this.engine.viewH/2, 0.8); this.onStroke('zoom_change', {scale: this.engine.scale}); break;
      case '0': this.engine.resetView(); this.onStroke('zoom_change', {scale: 1}); break;
      case 'f': case 'F': if (!e.ctrlKey && !e.metaKey) this.onStroke('tool', { tool: 'fill' }); break;
      case 'r': case 'R': if (!e.ctrlKey && !e.metaKey) { this.engine.resetView(); this.onStroke('zoom_change', {scale: this.engine.scale}); } break;
    }
  }

  _sampleColor(pos, preview = false) {
    const canvasPos = this.engine.screenToCanvas(pos.x, pos.y);
    // Sample from composited image
    const pixel = this.engine.ctx.getImageData(pos.x * this.engine.dpr, pos.y * this.engine.dpr, 1, 1).data;
    const color = `#${pixel[0].toString(16).padStart(2,'0')}${pixel[1].toString(16).padStart(2,'0')}${pixel[2].toString(16).padStart(2,'0')}`;
    this.onStroke(preview ? 'eyedropper_preview' : 'eyedropper_pick', { color, ...pos });
  }

  // Helpers
  _dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  _mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  _angle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
}
