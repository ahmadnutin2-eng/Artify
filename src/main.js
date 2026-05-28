import './style.css';
import './brush-ui.css';
import { CanvasEngine }  from './canvas/CanvasEngine.js';
import { InputHandler }  from './canvas/InputHandler.js';
import { UndoManager }   from './canvas/UndoManager.js';
import { BrushEngine }   from './brush/BrushEngine.js';
import { ColorSystem }   from './color/ColorSystem.js';
import { LayerManager }  from './layers/LayerManager.js';
import { CollabEngine }  from './collab/CollabEngine.js';
import { FloodFill }     from './brush/FloodFill.js';
import { ShapeDetector }    from './utils/ShapeDetector.js';
import { SubView }          from './utils/SubView.js';
import { PaletteExtractor } from './utils/PaletteExtractor.js';

// Suppress the ResizeObserver loop limit exceeded error which is a common Vite/HMR annoyance
window.addEventListener('error', e => {
  if (e.message?.includes('ResizeObserver loop')) {
    const overlay = document.querySelector('vite-error-overlay');
    if (overlay) overlay.remove();
    e.stopImmediatePropagation();
  }
});

// ══════════════════════════════════════════
//  UI UTILS
// ══════════════════════════════════════════
const toastContainer = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.appendChild(toastContainer);

function showToast(msg, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type.startsWith('linear-gradient') ? '' : type}`;
  if (type.startsWith('linear-gradient') || type.startsWith('rgba') || type.startsWith('#')) {
    toast.style.background = type;
  }
  toast.innerHTML = `<span>${msg}</span>`;
  toastContainer.appendChild(toast);
  console.log(`[DEBO-V5] TOAST: ${msg}`);
  setTimeout(() => {
    toast.style.animation = 'toast-in 0.3s forwards reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

window._activeDragColor = null;
window._lastFillData = null;

// ══════════════════════════════════════════
//  INIT CORE SYSTEMS
// ══════════════════════════════════════════
const canvasEl  = document.getElementById('main-canvas');
const overlayEl = document.getElementById('overlay-canvas');

const engine = new CanvasEngine(canvasEl, overlayEl);
let activeRulerHandle = null; // { ruler, type: 'h1'|'h2' }
let activeRuler = null;

const SNAP_THRESHOLD = 35; // Magnetism strength (pixels)
const FILL_EXPANSION = 8;  // Bleed into strokes

const undo   = new UndoManager(engine);
const layersMgr = new LayerManager(engine, document.getElementById('layers-list'));
const brush = new BrushEngine(engine);
engine._brushRef = brush;
const color = new ColorSystem();
const subview = new SubView();

// Force solid black default for boundary drawing
color.setHex('000000');
brush.setSize(12);
brush.setOpacity(1.0);
brush.setFlow(1.0);

const collab = new CollabEngine(engine, brush);

// Temporary canvas for shape drawing previews
const shapePreviewCanvas = new OffscreenCanvas(engine.docWidth, engine.docHeight); 
const shapePreviewCtx = shapePreviewCanvas.getContext('2d');
let shapeStartX = 0;
let shapeStartY = 0;

// Gradient Tool State
let gradientMaskCanvas = null;
let gradientStartX = 0;
let gradientStartY = 0;
let gradientColorA = '#000000';
let gradientColorB = '#000000';

// Fill Settings State
let fillToleranceValue = 32;
let gapFillValue = 4;

// Override engine to pull strokeCanvas from brush or shapes
Object.defineProperty(engine, '_activeStrokeCanvas', {
  get: () => {
    if (activeTool.startsWith('shape-') && isStrokeActive) return shapePreviewCanvas;
    return brush.strokeCanvas;
  },
  set: () => {},
  configurable: true
});

brush.setColor('#000000');
brush.applyPreset('pencil-hb');

function updateBlendModeUI() {
  const layer = engine.getActiveLayer();
  const sel = document.getElementById('blend-mode-select');
  if (sel && layer) sel.value = layer.blendMode || 'source-over';
}
document.getElementById('blend-mode-select')?.addEventListener('change', e => {
  const layer = engine.getActiveLayer();
  if (layer) { layer.blendMode = e.target.value; engine.markDirty(); }
});
layersMgr.onLayerChange = () => {
  updateBlendModeUI();
};

// ══════════════════════════════════════════
//  DRAWING STATE
// ══════════════════════════════════════════
let activeTool = 'brush';
let isStrokeActive = false;
let gradientSamplingTarget = null; // 'a' or 'b'

// QuickSnap State
let currentPathPoints = [];
let quickSnapTimer = null;
let quickSnapActive = false;
let snappedShape = null;
const QUICKSNAP_DWELL = 550; // ms to hold to snap

// Ruler State
let rulerStartX = 0;
let rulerStartY = 0;

// Shading Bar State
let autoShadingMode = false;

let gradientPreviewCtx    = gradientPreviewCanvas.getContext('2d');

// QuickSnap Preview
const qsPreviewCanvas = new OffscreenCanvas(engine.docWidth, engine.docHeight);
const qsPreviewCtx = qsPreviewCanvas.getContext('2d');

// ── The One and Only Input Handler ──
// --- Helper for Smart Fill Targeting ---
function findSmartSamplePoint(x, y) {
  const sampleRadius = 8;
  const step = 2;
  let bestPoint = { x, y };
  let maxBrightness = -1;

  // Check current point
  const current = engine.sampleColor(x, y);
  const rgb = current.match(/[A-Za-z0-9]{2}/g).map(h => parseInt(h, 16));
  const brightness = rgb[0] + rgb[1] + rgb[2];
  
  // If current point is already bright (likely an area), use it
  if (brightness > 400) return bestPoint;

  // Spiral search for the nearest bright area pixel
  for (let r = step; r <= sampleRadius; r += step) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      const sx = x + Math.round(r * Math.cos(angle));
      const sy = y + Math.round(r * Math.sin(angle));
      const hex = engine.sampleColor(sx, sy);
      const s_rgb = hex.match(/[A-Za-z0-9]{2}/g).map(h => parseInt(h, 16));
      const s_brightness = s_rgb[0] + s_rgb[1] + s_rgb[2];
      
      if (s_brightness > maxBrightness) {
        maxBrightness = s_brightness;
        bestPoint = { x: sx, y: sy };
      }
      if (maxBrightness > 500) return bestPoint; // Found a good spot
    }
  }
  return bestPoint;
}

function getSnappedPoint(x, y) {
  if (engine.activeRulers.length === 0) return { x, y };
  
  let bestDist = SNAP_THRESHOLD;
  let snapped = { x, y };

  engine.activeRulers.forEach(r => {
    // Project point (x,y) onto line segment (r.x1, r.y1) to (r.x2, r.y2)
    const dx = r.x2 - r.x1;
    const dy = r.y2 - r.y1;
    const l2 = dx*dx + dy*dy;
    if (l2 === 0) return;

    let t = ((x - r.x1) * dx + (y - r.y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t)); // Clamp to segment

    const px = r.x1 + t * dx;
    const py = r.y1 + t * dy;
    const dist = Math.hypot(x - px, y - py);

    if (dist < bestDist) {
      bestDist = dist;
      snapped = { x: px, y: py };
    }
  });

  return snapped;
}

const zenTools = ['brush', 'eraser', 'smudge', 'selection', 'lasso'];

const input = new InputHandler(canvasEl, engine, (type, data) => {
  switch (type) {
    case 'stroke_start':
    case 'selection_start':
      if (zenTools.includes(activeTool)) {
        document.body.classList.add('zen-mode');
      }
      break;
    case 'stroke_end':
    case 'selection_end':
      setTimeout(() => {
        if (!input.isDrawing && !input.isPanning) {
          document.body.classList.remove('zen-mode');
        }
      }, 300);
      break;
  }

  switch (type) {
    case 'selection_start':
      engine.clearOverlay();
      break;
    case 'selection_move': {
      const octx = engine.getOverlayCtx();
      engine.clearOverlay();
      octx.setLineDash([5, 5]);
      octx.strokeStyle = '#fff';
      octx.lineWidth = 2;
      octx.beginPath();
      data.points.forEach((p, i) => {
        const s = engine.canvasToScreen(p.x, p.y);
        i === 0 ? octx.moveTo(s.x, s.y) : octx.lineTo(s.x, s.y);
      });
      octx.stroke();
      break;
    }
    case 'selection_end':
      engine.clearOverlay();
      if (data.points.length > 3) {
        engine.createSelection(data.points);
        resetSelSliders();
        document.getElementById('selection-toolbar')?.classList.remove('hidden');
        showToast('Selection Active: Transform or use Toolbar.', 'info');
      }
      break;
    case 'long_press':
      if (isStrokeActive && activeTool === 'brush') {
        // Trigger QuickSnap
        const detected = ShapeDetector.detect(currentPathPoints);
        if (detected) {
          quickSnapActive = true;
          snappedShape = detected;
          // Store the pivot point (center of shape) for transformation
          window._qsPivot = { x: detected.center.x, y: detected.center.y };
          window._qsStartDist = Math.hypot(data.x - window._qsPivot.x, data.y - window._qsPivot.y);
          window._qsStartAngle = Math.atan2(data.y - window._qsPivot.y, data.x - window._qsPivot.x);
          window._qsOrigShape = JSON.parse(JSON.stringify(detected));
          
          showToast(`QuickSnap: ${detected.type} detected`, 'success', 1000);
          engine.markDirty();
        }
      } else {
        openPaletteModal();
      }
      break;
    case 'stroke_start': {
      window._lastFillData = null;
      const layer = engine.getActiveLayer();
      if (layer?.locked) return;
      undo.snapshot('stroke');
      
      if (activeTool === 'text') {
        spawnTextTool(data.x, data.y);
      } else if (activeTool.startsWith('shape-')) {
        isStrokeActive = true;
        shapeStartX = data.x;
        shapeStartY = data.y;
        if (shapePreviewCanvas.width !== engine.docWidth || shapePreviewCanvas.height !== engine.docHeight) {
          shapePreviewCanvas.width = engine.docWidth;
          shapePreviewCanvas.height = engine.docHeight;
        }
        shapePreviewCtx.clearRect(0, 0, shapePreviewCanvas.width, shapePreviewCanvas.height);
      } else if (activeTool === 'gradient' || window._isShadingMode) {
        const layer = engine.getActiveLayer();
        if (!layer) return;
        isStrokeActive = true;
        
        const smartPoint = findSmartSamplePoint(data.x, data.y);
        gradientStartX = smartPoint.x;
        gradientStartY = smartPoint.y;
        
        const snapCanvas = document.createElement('canvas');
        snapCanvas.width = engine.docWidth; snapCanvas.height = engine.docHeight;
        const snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
        snapCtx.fillStyle = '#ffffff';
        snapCtx.fillRect(0, 0, engine.docWidth, engine.docHeight);
        engine._drawLayers(snapCtx);
        
        gradientMaskCanvas = FloodFill.computeFillMask(snapCtx, gradientStartX, gradientStartY, engine.docWidth, engine.docHeight, '#000000', fillToleranceValue, gapFillValue, FILL_EXPANSION);

        if (window._isShadingMode) {
           // If shading, use colors from the shading variant
           gradientColorA = window._shadingBaseColor;
           gradientColorB = window._shadingTargetColor;
        } else {
           gradientColorA = document.getElementById('grad-color-a').value;
           gradientColorB = document.getElementById('grad-color-b').value;
        }
      } else if (activeTool === 'ruler') {
        // Check for handle interaction first
        const screenX = data.x * engine.scale + engine.offsetX;
        const screenY = data.y * engine.scale + engine.offsetY;
        
        let foundHandle = false;
        for (const r of engine.activeRulers) {
           const dist1 = Math.hypot(screenX - r.h1.x, screenY - r.h1.y);
           const dist2 = Math.hypot(screenX - r.h2.x, screenY - r.h2.y);
           const distClose = Math.hypot(screenX - r.hClose.x, screenY - r.hClose.y);
           
           if (distClose < 15) {
              engine.activeRulers = engine.activeRulers.filter(rr => rr !== r);
              engine.markDirty();
              foundHandle = true;
              break;
           }
           if (dist1 < 10) { activeRulerHandle = { ruler: r, type: 'h1' }; foundHandle = true; break; }
           if (dist2 < 10) { activeRulerHandle = { ruler: r, type: 'h2' }; foundHandle = true; break; }
        }

        if (!foundHandle) {
           isStrokeActive = true;
           rulerStartX = data.x;
           rulerStartY = data.y;
        } else {
           isStrokeActive = true; // Still active for drag
        }
      } else if (activeTool === 'eyedropper' || gradientSamplingTarget) {
        const sampled = engine.sampleColor(data.x, data.y);
        if (gradientSamplingTarget) {
          document.getElementById(`grad-color-${gradientSamplingTarget}`).value = sampled;
          stopGradientSampling();
        } else {
          color.setHex(sampled.replace('#', ''));
          syncColorUI();
          setTool('brush');
        }
      } else {
        isStrokeActive = true;
        const snapped = getSnappedPoint(data.x, data.y);
        
        // Reset QuickSnap
        currentPathPoints = [{ x: snapped.x, y: snapped.y }];
        quickSnapActive = false;
        snappedShape = null;
        if (quickSnapTimer) clearTimeout(quickSnapTimer);

        brush.beginStroke(snapped.x, snapped.y, data.pressure);
        collab.sendStrokeEvent('stroke_start', { x: snapped.x, y: snapped.y, pressure: data.pressure, mode: activeTool, color: color.toHex(), size: brush.settings.size, opacity: brush.settings.opacity, flow: brush.settings.flow, preset: brush.settings.preset });
      }
      break;
    }
    case 'hover': {
      if (!isStrokeActive && !activeTool.startsWith('shape-') && activeTool !== 'text') {
        brush.drawCursor(data.x, data.y, data.pressure);
      }
      collab.sendCursor(data.x, data.y);
      break;
    }
    case 'hover_out':
      engine.clearOverlay();
      break;
    case 'stroke_move': {
      if (!isStrokeActive) return;
      if (activeTool.startsWith('shape-')) {
        shapePreviewCtx.clearRect(0, 0, shapePreviewCanvas.width, shapePreviewCanvas.height);
        shapePreviewCtx.save();
        shapePreviewCtx.strokeStyle = color.toHex();
        shapePreviewCtx.fillStyle = color.toHex(); 
        shapePreviewCtx.lineWidth = brush.settings.size;
        shapePreviewCtx.globalAlpha = brush.settings.opacity;
        shapePreviewCtx.lineCap = 'round'; shapePreviewCtx.lineJoin = 'round';
        shapePreviewCtx.beginPath();
        if (activeTool === 'shape-rect') shapePreviewCtx.rect(shapeStartX, shapeStartY, data.x - shapeStartX, data.y - shapeStartY);
        else if (activeTool === 'shape-circle') {
          const r = Math.hypot(data.x - shapeStartX, data.y - shapeStartY);
          shapePreviewCtx.arc(shapeStartX, shapeStartY, r, 0, Math.PI * 2);
        } else if (activeTool === 'shape-line') {
          shapePreviewCtx.moveTo(shapeStartX, shapeStartY);
          shapePreviewCtx.lineTo(data.x, data.y);
        }
        shapePreviewCtx.stroke();
        shapePreviewCtx.restore();
        engine.markDirty();
      } else if (activeTool === 'ruler') {
        if (activeRulerHandle) {
           const r = activeRulerHandle.ruler;
           if (activeRulerHandle.type === 'h1') { r.x1 = data.x; r.y1 = data.y; }
           else { r.x2 = data.x; r.y2 = data.y; }
           engine.markDirty();
        } else {
           engine.clearOverlay();
           const ctx = engine.getOverlayCtx();
           const dpr = engine.dpr;
           ctx.save();
           ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
           const x1 = rulerStartX * engine.scale + engine.offsetX;
           const y1 = rulerStartY * engine.scale + engine.offsetY;
           const x2 = data.x * engine.scale + engine.offsetX;
           const y2 = data.y * engine.scale + engine.offsetY;
           ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
           ctx.lineWidth = 2;
           ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
           ctx.restore();
        }
      } else if ((activeTool === 'gradient' || window._isShadingMode) && isStrokeActive) {
        engine.clearOverlay();
        if (gradientMaskCanvas) {
          if (gradientPreviewCanvas.width !== engine.docWidth || gradientPreviewCanvas.height !== engine.docHeight) {
            gradientPreviewCanvas.width = engine.docWidth;
            gradientPreviewCanvas.height = engine.docHeight;
          }
          gradientPreviewCtx.clearRect(0, 0, engine.docWidth, engine.docHeight);
          gradientPreviewCtx.save();
          gradientPreviewCtx.drawImage(gradientMaskCanvas, 0, 0);
          gradientPreviewCtx.globalCompositeOperation = 'source-in';
          
          const grad = gradientPreviewCtx.createLinearGradient(gradientStartX, gradientStartY, data.x, data.y);
          grad.addColorStop(0, gradientColorA);
          grad.addColorStop(1, gradientColorB);
          
          gradientPreviewCtx.fillStyle = grad;
          gradientPreviewCtx.fillRect(0, 0, engine.docWidth, engine.docHeight);
          gradientPreviewCtx.restore();
          engine.setStrokeCanvas(gradientPreviewCanvas);
        }
        
        // --- Overlay Arrow ---
        const octx = engine.getOverlayCtx();
        const dpr = engine.dpr;
        octx.save();
        octx.setTransform(engine.scale * dpr, 0, 0, engine.scale * dpr, engine.offsetX * dpr, engine.offsetY * dpr);
        octx.shadowColor = 'rgba(0,0,0,0.5)';
        octx.shadowBlur = 4 / engine.scale;
        octx.strokeStyle = '#FFFFFF';
        octx.lineWidth = 4 / engine.scale;
        octx.beginPath();
        octx.moveTo(gradientStartX, gradientStartY);
        octx.lineTo(data.x, data.y);
        octx.stroke();
        const angle = Math.atan2(data.y - gradientStartY, data.x - gradientStartX);
        const headLen = 20 / engine.scale;
        octx.beginPath();
        octx.moveTo(data.x, data.y);
        octx.lineTo(data.x - headLen * Math.cos(angle - Math.PI/6), data.y - headLen * Math.sin(angle - Math.PI/6));
        octx.lineTo(data.x - headLen * Math.cos(angle + Math.PI/6), data.y - headLen * Math.sin(angle + Math.PI/6));
        octx.closePath();
        octx.fillStyle = '#FFFFFF';
        octx.fill();
        octx.restore();
      } else {
        const snapped = getSnappedPoint(data.x, data.y);
        
        // --- QuickSnap Logic ---
        currentPathPoints.push({ x: snapped.x, y: snapped.y });
        
        // Track dwell: if the point hasn't moved much, start/continue the timer
        const lastP = currentPathPoints[currentPathPoints.length - 2];
        const distMoved = lastP ? Math.hypot(snapped.x - lastP.x, snapped.y - lastP.y) : 0;
        
        if (distMoved < 2) {
          if (!quickSnapTimer && !quickSnapActive) {
            quickSnapTimer = setTimeout(() => {
              const detection = ShapeDetector.detect(currentPathPoints);
              if (detection) {
                quickSnapActive = true;
                snappedShape = detection;
                
                // --- Initialize Transformation Pivot ---
                // Defensive check for center (fallback to bounds)
                const px = detection.center ? detection.center.x : (detection.bounds.min.x + detection.bounds.max.x) / 2;
                const py = detection.center ? detection.center.y : (detection.bounds.min.y + detection.bounds.max.y) / 2;
                
                window._qsPivot = { x: px, y: py };
                window._qsStartDist = Math.hypot(snapped.x - window._qsPivot.x, snapped.y - window._qsPivot.y);
                window._qsStartAngle = Math.atan2(snapped.y - window._qsPivot.y, snapped.x - window._qsPivot.x);
                window._qsOrigShape = JSON.parse(JSON.stringify(detection));

                showToast(`✨ Snapped to ${detection.type}`, 'rgba(123, 47, 255, 0.8)');
                engine.markDirty();
              }
            }, window._qsDwell || QUICKSNAP_DWELL);
          }
        } else {
          if (!quickSnapActive) {
            if (quickSnapTimer) clearTimeout(quickSnapTimer);
            quickSnapTimer = null;
          }
        }

        if (quickSnapActive && snappedShape) {
          // --- Transformation Math ---
          const dx = snapped.x - window._qsPivot.x;
          const dy = snapped.y - window._qsPivot.y;
          const dist = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          
          const scale = window._qsStartDist > 10 ? dist / window._qsStartDist : 1;
          const rot = angle - window._qsStartAngle;
          
          // Update shape properties
          if (snappedShape.type === 'circle') {
            snappedShape.radius = window._qsOrigShape.radius * scale;
          } else if (snappedShape.type === 'rectangle') {
            snappedShape.width = window._qsOrigShape.width * scale;
            snappedShape.height = window._qsOrigShape.height * scale;
            snappedShape.rotation = (window._qsOrigShape.rotation || 0) + rot;
          } else if (snappedShape.type === 'line') {
            snappedShape.length = window._qsOrigShape.length * scale;
            snappedShape.angle = (window._qsOrigShape.angle || 0) + rot;
          }

          // --- Render to High-Fi Preview Canvas ---
          qsPreviewCtx.clearRect(0, 0, qsPreviewCanvas.width, qsPreviewCanvas.height);
          qsPreviewCtx.save();
          qsPreviewCtx.strokeStyle = brush.color;
          qsPreviewCtx.lineWidth = brush.settings.size;
          qsPreviewCtx.lineCap = 'round';
          qsPreviewCtx.lineJoin = 'round';
          
          if (snappedShape.type === 'circle') {
            qsPreviewCtx.beginPath();
            qsPreviewCtx.arc(snappedShape.center.x, snappedShape.center.y, snappedShape.radius, 0, Math.PI * 2);
            qsPreviewCtx.stroke();
          } else if (snappedShape.type === 'rectangle') {
            qsPreviewCtx.save();
            qsPreviewCtx.translate(snappedShape.center.x, snappedShape.center.y);
            if (snappedShape.rotation) qsPreviewCtx.rotate(snappedShape.rotation);
            qsPreviewCtx.strokeRect(-snappedShape.width/2, -snappedShape.height/2, snappedShape.width, snappedShape.height);
            qsPreviewCtx.restore();
          } else if (snappedShape.type === 'line') {
            const lx1 = snappedShape.center.x - Math.cos(snappedShape.angle) * snappedShape.length/2;
            const ly1 = snappedShape.center.y - Math.sin(snappedShape.angle) * snappedShape.length/2;
            const lx2 = snappedShape.center.x + Math.cos(snappedShape.angle) * snappedShape.length/2;
            const ly2 = snappedShape.center.y + Math.sin(snappedShape.angle) * snappedShape.length/2;
            qsPreviewCtx.beginPath();
            qsPreviewCtx.moveTo(lx1, ly1);
            qsPreviewCtx.lineTo(lx2, ly2);
            qsPreviewCtx.stroke();
          }
          qsPreviewCtx.restore();
          engine.setStrokeCanvas(qsPreviewCanvas);
          engine.markDirty();
        } else {
          brush.continueStroke(snapped.x, snapped.y, data.pressure, data.speed, activeTool);
          engine.markDirty();
          collab.sendStrokeEvent('stroke_move', { x: snapped.x, y: snapped.y, pressure: data.pressure, speed: data.speed });
        }
      }
      collab.sendCursor(data.x, data.y);
      break;
    }
    case 'stroke_end': {
      if (!isStrokeActive) return;
      isStrokeActive = false;

      if (activeTool.startsWith('shape-')) {
        const layer = engine.getActiveLayer();
        if (layer && !layer.locked) {
          layer.ctx.globalAlpha = 1;
          layer.ctx.drawImage(shapePreviewCanvas, 0, 0);
          engine.markDirty();
        }
      } else if (activeTool === 'ruler') {
        if (!activeRulerHandle) {
           engine.addRuler(rulerStartX, rulerStartY, data.x, data.y);
        }
        activeRulerHandle = null;
      } else if (activeTool === 'gradient' || window._isShadingMode) {
        const layer = engine.getActiveLayer();
        if (layer && !layer.locked && gradientMaskCanvas) {
          const gradCanvas = document.createElement('canvas');
          gradCanvas.width = engine.docWidth; gradCanvas.height = engine.docHeight;
          const gCtx = gradCanvas.getContext('2d');
          const grad = gCtx.createLinearGradient(gradientStartX, gradientStartY, data.x, data.y);
          grad.addColorStop(0, gradientColorA);
          grad.addColorStop(1, gradientColorB);
          gCtx.fillStyle = grad;
          gCtx.fillRect(0, 0, engine.docWidth, engine.docHeight);
          
          const finalCanvas = document.createElement('canvas');
          finalCanvas.width = engine.docWidth; finalCanvas.height = engine.docHeight;
          const fCtx = finalCanvas.getContext('2d');
          fCtx.drawImage(gradientMaskCanvas, 0, 0);
          fCtx.globalCompositeOperation = 'source-in';
          fCtx.drawImage(gradCanvas, 0, 0);
          
          layer.ctx.drawImage(finalCanvas, 0, 0);
          engine.markDirty();
        }
        gradientMaskCanvas = null;
        engine.setStrokeCanvas(null);
        if (window._isShadingMode) exitShadingMode();
      } else if (quickSnapActive && snappedShape) {
        // Commit snapped shape
        const layer = engine.getActiveLayer();
        if (layer && !layer.locked) {
          const lctx = layer.ctx;
          lctx.save();
          lctx.strokeStyle = brush.color;
          lctx.lineWidth = brush.settings.size;
          lctx.lineCap = 'round';
          lctx.lineJoin = 'round';
          
          if (snappedShape.type === 'circle') {
            lctx.beginPath();
            lctx.arc(snappedShape.center.x, snappedShape.center.y, snappedShape.radius, 0, Math.PI * 2);
            lctx.stroke();
          } else if (snappedShape.type === 'rectangle') {
            lctx.save();
            lctx.translate(snappedShape.center.x, snappedShape.center.y);
            if (snappedShape.rotation) lctx.rotate(snappedShape.rotation);
            lctx.strokeRect(-snappedShape.width/2, -snappedShape.height/2, snappedShape.width, snappedShape.height);
            lctx.restore();
          } else if (snappedShape.type === 'line') {
            const lx1 = snappedShape.center.x - Math.cos(snappedShape.angle) * snappedShape.length/2;
            const ly1 = snappedShape.center.y - Math.sin(snappedShape.angle) * snappedShape.length/2;
            const lx2 = snappedShape.center.x + Math.cos(snappedShape.angle) * snappedShape.length/2;
            const ly2 = snappedShape.center.y + Math.sin(snappedShape.angle) * snappedShape.length/2;
            lctx.beginPath();
            lctx.moveTo(lx1, ly1);
            lctx.lineTo(lx2, ly2);
            lctx.stroke();
          }
          lctx.restore();
          
          brush.endStroke(); 
          engine.markDirty();
          undo.snapshot('quick_snap');
        }
      } else {
        brush.endStroke(activeTool);
        collab.sendStrokeEvent('stroke_end', {});
        updateBrushPreview();
      }

      // Final cleanup
      if (quickSnapTimer) clearTimeout(quickSnapTimer);
      quickSnapTimer = null;
      quickSnapActive = false;
      snappedShape = null;
      engine.clearOverlay();
      
      color.addToHistory(color.toHex());
      renderColorHistory();
      break;
    }
    case 'undo': window._lastFillData = null; undo.undo(); engine.markDirty(); break;
    case 'redo': window._lastFillData = null; undo.redo(); engine.markDirty(); break;
    case 'zoom_change': updateZoomUI(data.scale || engine.scale); break;
    case 'tool': setTool(data.tool); break;
    case 'brush_size': {
      const newSize = Math.max(1, Math.min(200, brush.settings.size + data.delta));
      brush.setSize(newSize);
      brushSizeSlider.value = newSize;
      document.getElementById('brush-size-val').textContent = newSize + 'px';
      updateSizeIndicator();
      updateBrushPreview();
      break;
    }
    case 'eyedropper_pick':
      color.setHex(data.color.replace('#',''));
      syncColorUI();
      setTool('brush');
      break;
    case 'fill_click':
      runFloodFill(data, color.toHex());
      break;
  }
});

// ── Remote Stroke Receiver ──
collab.onStrokeReceived = (stroke) => {
  if (stroke.type === 'stroke_start') {
    brush.setColor(stroke.color);
    brush.setSize(stroke.size);
    brush.setOpacity(stroke.opacity);
    brush.setFlow(stroke.flow);
    brush.beginStroke(stroke.x, stroke.y, stroke.pressure);
  } else if (stroke.type === 'stroke_move') {
    brush.continueStroke(stroke.x, stroke.y, stroke.pressure, stroke.speed || 0, stroke.mode || 'brush');
    engine.markDirty();
  } else if (stroke.type === 'stroke_end') {
    brush.endStroke(stroke.mode || 'brush');
    brush.setColor(color.toHex());
    brush.setSize(+brushSizeSlider.value);
    brush.setOpacity(+brushOpSlider.value / 100);
  } else if (stroke.type === 'fill') {
    runFloodFill({ x: stroke.x, y: stroke.y }, stroke.color, true); 
  }
};

// ══════════════════════════════════════════
//  TEXT TOOL
// ══════════════════════════════════════════
function spawnTextTool(x, y) {
  isStrokeActive = false;
  const screenPos = engine.canvasToScreen(x, y);
  const inp = document.createElement('textarea');
  inp.style.position = 'absolute';
  inp.style.left = screenPos.x + 'px';
  inp.style.top = screenPos.y + 'px';
  inp.style.background = 'transparent';
  inp.style.color = color.toHex();
  const brushSize = brush.settings.size;
  const scaledSize = brushSize * engine.scale;
  inp.style.fontSize = scaledSize + 'px';
  inp.style.fontFamily = 'Inter, sans-serif'; 
  inp.style.border = '2px dashed #999';
  inp.style.outline = 'none';
  inp.style.minWidth = '100px';
  inp.style.minHeight = scaledSize + 20 + 'px';
  inp.style.zIndex = 1000;
  inp.style.overflow = 'hidden';
  inp.placeholder = 'Type...';
  
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = inp.scrollHeight + 'px';
  });

  document.body.appendChild(inp);
  inp.focus();

  inp.addEventListener('blur', () => {
     if (inp.value.trim().length > 0) {
        const layer = engine.getActiveLayer();
        if (layer && !layer.locked) {
           const ctx = layer.ctx;
           ctx.save();
           ctx.globalAlpha = brush.settings.opacity;
           ctx.fillStyle = color.toHex();
           ctx.font = `${brushSize}px Inter, sans-serif`;
           ctx.textBaseline = 'top';
           const lines = inp.value.split('\n');
           for (let i = 0; i < lines.length; i++) {
             ctx.fillText(lines[i], x, y + i * (brushSize * 1.2));
           }
           ctx.restore();
           engine.markDirty();
        }
     }
     inp.remove();
  });
}

// ══════════════════════════════════════════
//  TOOL SWITCHING
// ══════════════════════════════════════════
function setTool(tool) {
  console.log('[DEBUG-V5] setTool:', tool);
  if (tool === 'brush' && activeTool === 'brush') {
    document.getElementById('btn-brush-library')?.click();
  }
  activeTool = tool;
  input.setMode(tool);
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`tool-${tool}`);
  if (btn) btn.classList.add('active');

  const container = document.getElementById('canvas-container');
  if (container) {
    if (tool === 'eyedropper' || tool === 'gradient' || tool === 'lasso' || tool === 'fill') {
      container.style.cursor = 'crosshair';
    } else if (tool === 'selection') {
      container.style.cursor = 'default';
    } else {
      container.style.cursor = 'none';
    }
  }
  
  if (tool === 'gradient') openPanel('colors');
  if (tool === 'lasso') showToast('Lasso Active: Draw a closed loop to select.', 'info', 2000);
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// ══════════════════════════════════════════
//  COLOR UI
// ══════════════════════════════════════════
color.init(
  document.getElementById('color-wheel'),
  document.getElementById('color-square')
);

color.onChange = (state) => {
  syncColorInputsFromState(state);
  brush.setColor(state.hex);
  document.getElementById('color-swatch').style.background = state.hex;
  renderHarmony();
};

function syncColorUI() {
  const state = color.getState();
  syncColorInputsFromState(state);
  brush.setColor(state.hex);
  document.getElementById('color-swatch').style.background = state.hex;
  renderHarmony();
  if (autoShadingMode) updateSmartShadingBar();
}

function syncColorInputsFromState(state) {
  document.getElementById('slider-h').value = state.h;
  document.getElementById('input-h').value = Math.round(state.h);
  document.getElementById('slider-s').value = state.s;
  document.getElementById('input-s').value = Math.round(state.s);
  document.getElementById('slider-b').value = state.b;
  document.getElementById('input-b').value = Math.round(state.b);
  document.getElementById('slider-a').value = state.a;
  document.getElementById('input-a').value = Math.round(state.a);
  document.getElementById('input-hex').value = state.hex.replace('#','').toUpperCase();
}

[['h','setH'],['s','setS'],['b','setB'],['a','setA']].forEach(([ch, fn]) => {
  document.getElementById(`slider-${ch}`).addEventListener('input', e => color[fn](+e.target.value));
  document.getElementById(`input-${ch}`).addEventListener('change', e => color[fn](+e.target.value));
});

document.getElementById('input-hex').addEventListener('change', e => {
  if (e.target.value.length === 6) color.setHex(e.target.value);
});

let colorSwatchLastClick = 0;
document.getElementById('color-swatch').addEventListener('click', () => {
  const now = Date.now();
  if (now - colorSwatchLastClick < 300) {
    // Double click triggers RCM Panel
    if (window.toggleRcmPanel) window.toggleRcmPanel();
  } else {
    // Single click
    openPanel('colors');
  }
  colorSwatchLastClick = now;
});

// ── ColorDrop (Drag & Drop Fill) ──
const topPalette = document.getElementById('top-palette');
const paletteColors = ['#4D9EFF','#A78BFA','#F472B6','#FB7185','#FBBF24','#34D399','#FFFFFF','#0D0D0D'];

function initTopPalette() {
  topPalette.innerHTML = '';
  paletteColors.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.backgroundColor = hex;
    sw.draggable = true;
    sw.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', hex);
      e.dataTransfer.setData('color-hex', hex);
      window._activeDragColor = hex;
    });
    sw.addEventListener('click', () => {
      color.setHex(hex.replace('#', ''));
      syncColorUI();
    });
    topPalette.appendChild(sw);
  });
}
initTopPalette();

// ── Fill Settings UI ──
const fillToleranceSlider = document.getElementById('fill-tolerance');
const gapFillSlider = document.getElementById('gap-fill');
const fillToleranceVal = document.getElementById('fill-tolerance-val');
const gapFillVal = document.getElementById('gap-fill-val');

fillToleranceSlider?.addEventListener('input', (e) => {
  fillToleranceValue = parseInt(e.target.value);
  if (fillToleranceVal) fillToleranceVal.textContent = fillToleranceValue + '%';
});

gapFillSlider?.addEventListener('input', (e) => {
  gapFillValue = parseInt(e.target.value);
  if (gapFillVal) gapFillVal.textContent = gapFillValue + 'px';
});

document.getElementById('color-swatch').addEventListener('dragstart', (e) => {
  const hex = color.toHex();
  e.dataTransfer.setData('text/plain', hex);
  window._activeDragColor = hex;
});

const canvasWrapper = canvasEl.parentElement;
canvasWrapper.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

function runFloodFill(pt, hex, isRemote = false) {
  const activeLayer = engine.getActiveLayer();
  if (!activeLayer) return;

  const snapCanvas = document.createElement('canvas');
  snapCanvas.width = engine.docWidth; snapCanvas.height = engine.docHeight;
  const snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
  snapCtx.fillStyle = '#ffffff';
  snapCtx.fillRect(0, 0, engine.docWidth, engine.docHeight);
  engine._drawLayers(snapCtx);

  let fillPt = { x: Math.round(pt.x), y: Math.round(pt.y) };
  // Optimize by running computeFillMask synchronously and skipping animation
  const fillMaskCanvas = FloodFill.computeFillMask(snapCtx, fillPt.x, fillPt.y, engine.docWidth, engine.docHeight, hex, fillToleranceValue, gapFillValue, FILL_EXPANSION);
  if (!fillMaskCanvas) return;

  undo.snapshot('fill');
  const dpr = engine.dpr;

  engine.clearOverlay();
  const beforeCanvas = document.createElement('canvas');
  beforeCanvas.width = engine.docWidth; beforeCanvas.height = engine.docHeight;
  beforeCanvas.getContext('2d').drawImage(activeLayer.canvas, 0, 0);
  
  window._lastFillData = {
    layer: activeLayer,
    beforeCanvas: beforeCanvas,
    mask: fillMaskCanvas,
    hex: hex,
    pt: fillPt
  };

  activeLayer.ctx.drawImage(fillMaskCanvas, 0, 0);
  engine.markDirty();
  if (!isRemote) collab.sendFillEvent(fillPt.x, fillPt.y, hex);
}

function spawnDroplets(x, y, colorStr) {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  const splashCnv = document.createElement('canvas');
  splashCnv.width = canvasEl.width;
  splashCnv.height = canvasEl.height;
  splashCnv.style.position = 'absolute';
  splashCnv.style.top = '0';
  splashCnv.style.left = '0';
  splashCnv.style.width = '100%';
  splashCnv.style.height = '100%';
  splashCnv.style.pointerEvents = 'none';
  splashCnv.style.zIndex = '50';
  container.appendChild(splashCnv);

  const ctx = splashCnv.getContext('2d');
  const dpr = engine.dpr;
  const numDroplets = 50;
  const particles = [];
  
  for(let i=0; i<numDroplets; i++) {
      const pAngle = Math.random() * Math.PI * 2;
      const pSpeed = Math.random() * 30 + 15;
      particles.push({
          x: x, y: y,
          vx: Math.cos(pAngle) * pSpeed,
          vy: (Math.sin(pAngle) * pSpeed) * 0.5 - 25,
          radius: Math.random() * 1.5 + 0.5,
          alpha: 1.5,
          decay: Math.random() * 0.06 + 0.03
      });
  }

  function animateSplash() {
      let alive = false;
      ctx.clearRect(0, 0, splashCnv.width, splashCnv.height);
      ctx.save();
      ctx.setTransform(engine.scale * dpr, 0, 0, engine.scale * dpr, engine.offsetX * dpr, engine.offsetY * dpr);
      
      for (let p of particles) {
          p.vx *= 0.92;
          p.vy += 2.5;
          p.x += p.vx; p.y += p.vy;
          p.alpha -= p.decay;
          if (p.alpha > 0) {
              alive = true;
              ctx.globalAlpha = Math.min(1, p.alpha);
              ctx.fillStyle = colorStr;
              ctx.beginPath();
              ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
              ctx.fill();
          }
      }
      ctx.restore();
      if (alive) requestAnimationFrame(animateSplash);
      else splashCnv.remove();
  }
  requestAnimationFrame(animateSplash);
}

canvasWrapper.addEventListener('drop', (e) => {
  e.preventDefault();
  let hex = window._activeDragColor;
  const dtText = e.dataTransfer.getData('text/plain');
  if (!hex || !hex.startsWith('#')) hex = (dtText && dtText.startsWith('#')) ? dtText : color.toHex();
 
  console.log('[DEBO-V5] Drop Event Received. Color:', hex);
  showToast(`ColorDrop V5: ${hex}`, 'success');

  const rect = canvasEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const pt = engine.screenToCanvas(sx, sy);
  
  runFloodFill(pt, hex);
});

window.debugFill = (clientX, clientY, hexColor = '#ff00ff') => {
  const rect = canvasEl.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  runFloodFill(engine.screenToCanvas(sx, sy), hexColor);
};

// ══════════════════════════════════════════
//  HARMONY
// ══════════════════════════════════════════
function renderHarmony() {
  const harmonies = color.getHarmonyColors();
  const con = document.getElementById('harmony-swatches');
  if (!con) return;
  con.innerHTML = '';
  harmonies.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'harmony-swatch';
    sw.style.background = hex;
    sw.addEventListener('click', () => { color.setHex(hex.replace('#','')); syncColorUI(); });
    con.appendChild(sw);
  });
}

document.querySelectorAll('.harmony-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.harmony-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    color.harmonyMode = btn.dataset.mode;
    renderHarmony();
  });
});

// ══════════════════════════════════════════
//  COLOR HISTORY
// ══════════════════════════════════════════
function renderColorHistory() {
  const con = document.getElementById('color-history-swatches');
  if (!con) return;
  con.innerHTML = '';
  color.history.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'history-swatch';
    sw.style.background = hex;
    sw.addEventListener('click', () => { color.setHex(hex.replace('#','')); syncColorUI(); });
    con.appendChild(sw);
  });
}

// ══════════════════════════════════════════
//  GRADIENT STROKE UI
// ══════════════════════════════════════════
const gradToggle = document.getElementById('gradient-toggle');
const gradPanel  = document.getElementById('gradient-panel');
const gradColA   = document.getElementById('grad-color-a');
const gradColB   = document.getElementById('grad-color-b');
const gradLength = document.getElementById('grad-length');
const gradType   = document.getElementById('grad-type');

function syncGradientToBrush() {
  brush.setGradient(gradToggle.checked, gradColA.value, gradColB.value, parseInt(gradLength.value, 10), gradType.value);
  gradPanel.style.display = gradToggle.checked ? 'block' : 'none';
}
gradToggle.addEventListener('change', syncGradientToBrush);
gradColA.addEventListener('input', syncGradientToBrush);
gradColB.addEventListener('input', syncGradientToBrush);
gradType.addEventListener('change', syncGradientToBrush);
gradLength.addEventListener('input', syncGradientToBrush);

// ── Gradient Sampling UI ──
let stopGradientSampling = function() {
  gradientSamplingTarget = null;
  document.querySelectorAll('.grad-sample-btn').forEach(b => b.classList.remove('sampling'));
}

document.querySelectorAll('.grad-sample-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = btn.dataset.target;
    if (gradientSamplingTarget === target) {
      stopGradientSampling();
    } else {
      stopGradientSampling();
      gradientSamplingTarget = target;
      btn.classList.add('sampling');
      showToast(`Click canvas to sample ${target === 'a' ? 'Start' : 'End'} color`, 'info');
    }
  });
});

// Swap colors
document.getElementById('grad-swap')?.addEventListener('click', () => {
  const cA = document.getElementById('grad-color-a');
  const cB = document.getElementById('grad-color-b');
  const tmp = cA.value;
  cA.value = cB.value;
  cB.value = tmp;
  syncGradientToBrush();
});

// ── Realism Presets Logic ──
const realismModeSelect = document.getElementById('grad-realism-mode');
const realismIntensitySlider = document.getElementById('grad-intensity');
const realismIntensityVal = document.getElementById('grad-intensity-val');
const realismIntensityContainer = document.getElementById('grad-intensity-container');

function hexToHsl(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    let d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  l /= 100; s /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;
    r = hue2rgb(p, q, h / 360 + 1/3);
    g = hue2rgb(p, q, h / 360);
    b = hue2rgb(p, q, h / 360 - 1/3);
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function updateSmartGradient() {
  const mode = realismModeSelect.value;
  const intensity = parseInt(realismIntensitySlider.value) / 100;
  realismIntensityVal.textContent = realismIntensitySlider.value + '%';
  
  if (mode === 'manual') {
    realismIntensityContainer.style.display = 'none';
    return;
  }
  
  realismIntensityContainer.style.display = 'block';
  const colorA = document.getElementById('grad-color-a').value;
  let [h, s, l] = hexToHsl(colorA);
  let newHex = colorA;

  if (mode === 'shadow') {
    // Shading: Darker and slightly more saturated/cool
    l = Math.max(0, l - (intensity * 40));
    h = (h + (intensity * 10)) % 360; // Slight hue shift towards cool for realism
  } else if (mode === 'highlight') {
    // Tinting: Lighter and less saturated
    l = Math.min(100, l + (intensity * 40));
    s = Math.max(0, s - (intensity * 20));
  } else if (mode === 'fade') {
    // Fading: Less saturated, moves towards white/grey
    s = Math.max(0, s - (intensity * 100));
    l = l + (intensity * (90 - l));
  }

  newHex = hslToHex(h, s, l);
  document.getElementById('grad-color-b').value = newHex;
  syncGradientToBrush();
}

realismModeSelect.addEventListener('change', updateSmartGradient);
realismIntensitySlider.addEventListener('input', updateSmartGradient);
document.getElementById('grad-color-a').addEventListener('input', () => {
  if (realismModeSelect.value !== 'manual') updateSmartGradient();
});

// Update sampling logic to trigger smart update
const originalStopSampling = stopGradientSampling;
stopGradientSampling = function() {
  originalStopSampling();
  if (realismModeSelect.value !== 'manual') updateSmartGradient();
};

// ══════════════════════════════════════════
//  REALISTIC COLOR MODIFIER (RCM)
// ══════════════════════════════════════════
const rcmPanel = document.getElementById('rcm-panel');
const rcmDial = document.querySelector('.rcm-dial-wrapper');
const rcmIndicator = document.getElementById('rcm-dial-indicator');
const rcmAngTxt = document.getElementById('rcm-angle-value');

const rcmLum = document.getElementById('rcm-light-shadow');
const rcmFade = document.getElementById('rcm-fade');
const rcmSat = document.getElementById('rcm-boost');

let rcmAngle = 0;

function updateRcmDirection(x, y) {
  const rect = rcmDial.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  rcmAngle = Math.atan2(dy, dx) * 180 / Math.PI;
  
  rcmIndicator.style.transform = `translate(-50%, -50%) rotate(${rcmAngle + 90}deg) translateY(-26px)`;
  rcmAngTxt.textContent = `${Math.round(rcmAngle)}°`;
  updateRcmColors();
}

let isDialDragging = false;
rcmDial.addEventListener('mousedown', (e) => { isDialDragging = true; updateRcmDirection(e.clientX, e.clientY); });
window.addEventListener('mousemove', (e) => { if (isDialDragging) updateRcmDirection(e.clientX, e.clientY); });
window.addEventListener('mouseup', () => { isDialDragging = false; });
rcmDial.addEventListener('touchstart', (e) => { isDialDragging = true; updateRcmDirection(e.touches[0].clientX, e.touches[0].clientY); });
window.addEventListener('touchmove', (e) => { if (isDialDragging) updateRcmDirection(e.touches[0].clientX, e.touches[0].clientY); });
window.addEventListener('touchend', () => { isDialDragging = false; });

function updateRcmColors() {
   const baseHex = document.getElementById('input-hex').value; // current selected hex
   let [h, s, l] = hexToHsl('#' + baseHex);

   const lum = +rcmLum.value;
   const fade = +rcmFade.value;
   const sat = +rcmSat.value;

   // Color A (Highlight side - moving towards light)
   let hL = Math.min(100, Math.max(0, l + lum));
   let hS = Math.max(0, Math.min(100, s + sat - fade * 0.5));
   let colorA = hslToHex(h, hS, hL);

   // Color B (Shadow side - moving away)
   let sL = Math.max(0, Math.min(100, l - lum - fade * 0.5));
   let sS = Math.max(0, Math.min(100, s + sat * 1.5 - fade));
   let colorB = hslToHex(h, sS, sL);

   if (window._lastFillData) {
     const f = window._lastFillData;
     f.layer.ctx.clearRect(0, 0, engine.docWidth, engine.docHeight);
     f.layer.ctx.drawImage(f.beforeCanvas, 0, 0);
     
     const dx = Math.cos(rcmAngle * Math.PI / 180) * (engine.docWidth * 0.5);
     const dy = Math.sin(rcmAngle * Math.PI / 180) * (engine.docHeight * 0.5);
     const cx = f.pt.x;
     const cy = f.pt.y;
     
     const gradCvs = document.createElement('canvas');
     gradCvs.width = engine.docWidth; gradCvs.height = engine.docHeight;
     const gCtx = gradCvs.getContext('2d');
     
     const grad = gCtx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
     grad.addColorStop(0, colorA);
     grad.addColorStop(1, colorB);
     gCtx.fillStyle = grad;
     gCtx.fillRect(0, 0, engine.docWidth, engine.docHeight);
     
     gCtx.globalCompositeOperation = 'destination-in';
     gCtx.drawImage(f.mask, 0, 0);
     
     f.layer.ctx.drawImage(gradCvs, 0, 0);
     engine.markDirty();
   }

   brush.setGradient(true, colorA, colorB, 600, 'directional', rcmAngle);
}

[rcmLum, rcmFade, rcmSat].forEach(el => el.addEventListener('input', updateRcmColors));

window.toggleRcmPanel = function() {
  if (rcmPanel.classList.contains('rcm-hidden')) {
     rcmPanel.classList.remove('rcm-hidden');
     updateRcmColors();
  } else {
     rcmPanel.classList.add('rcm-hidden');
     brush.setGradient(false);
  }
};

document.getElementById('rcm-close').addEventListener('click', () => {
    rcmPanel.classList.add('rcm-hidden');
    brush.setGradient(false);
});

document.getElementById('btn-auto-realism').addEventListener('click', () => {
    rcmLum.value = 40;
    rcmFade.value = 10;
    rcmSat.value = 20;
    updateRcmColors();
});

// ══════════════════════════════════════════
// ══════════════════════════════════════════
//  GRID & RULER CONTROLS
// ══════════════════════════════════════════
document.getElementById('btn-grid')?.addEventListener('click', () => {
  engine.gridEnabled = !engine.gridEnabled;
  document.getElementById('btn-grid').classList.toggle('active', engine.gridEnabled);
  engine.markDirty();
  showToast(engine.gridEnabled ? 'Grid Enabled' : 'Grid Disabled');
});

document.getElementById('btn-snap')?.addEventListener('click', () => {
  input.gridSnap = !input.gridSnap;
  document.getElementById('btn-snap').classList.toggle('active', input.gridSnap);
  showToast(input.gridSnap ? 'Snapping Enabled' : 'Snapping Disabled');
});

const guidesPanel = document.getElementById('guides-panel');
const guidesBtn = document.getElementById('btn-guides');

guidesBtn?.addEventListener('click', () => {
  const active = guidesPanel?.classList.toggle('hidden');
  guidesBtn?.classList.toggle('active', !active);
});

document.getElementById('guides-close')?.addEventListener('click', () => {
  guidesPanel?.classList.add('hidden');
  guidesBtn?.classList.remove('active');
});

// Symmetry Listeners
const symToggle = document.getElementById('sym-toggle');
const symModeSelect = document.getElementById('sym-mode');
const radialSegmentsContainer = document.getElementById('radial-segments-container');
const symSegmentsInput = document.getElementById('sym-segments');

symToggle?.addEventListener('change', e => {
  brush.guides.setSymmetry(e.target.checked);
  engine.markDirty();
});

symModeSelect?.addEventListener('change', e => {
  brush.guides.setSymmetryMode(e.target.value);
  radialSegmentsContainer.classList.toggle('hidden', e.target.value !== 'radial');
  engine.markDirty();
});

symSegmentsInput?.addEventListener('input', e => {
  brush.guides.setRadialSegments(+e.target.value);
  document.getElementById('sym-segments-val').textContent = e.target.value;
  engine.markDirty();
});

// Perspective Listeners
const perToggle = document.getElementById('per-toggle');
const perTypeSelect = document.getElementById('per-type');

perToggle?.addEventListener('change', e => {
  brush.guides.setPerspective(e.target.checked);
  engine.markDirty();
});

perTypeSelect?.addEventListener('change', e => {
  brush.guides.setPerspectiveType(e.target.value);
  engine.markDirty();
});

// End of consolidated guides logic

// ══════════════════════════════════════════
//  SMART SHADING BAR
// ══════════════════════════════════════════
function updateSmartShadingBar() {
  const baseHex = color.toHex();
  const variants = generateShadingVariants(baseHex);
  const bar = document.getElementById('smart-shading-bar');
  if (!bar) return;
  
  const updateSwatch = (type, hex) => {
    const item = bar.querySelector(`[data-type="${type}"]`);
    if (!item) return;
    const box = item.querySelector('.ss-box');
    if (box) box.style.background = hex;
    item.onclick = () => {
      bar.querySelectorAll('.shading-swatch-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      color.setHex(hex.replace('#', ''));
      syncColorUI();
    };
  };

  updateSwatch('deep-shadow', variants.deepShadow);
  updateSwatch('shadow', variants.shadow);
  updateSwatch('base', baseHex);
  updateSwatch('highlight', variants.highlight);
  updateSwatch('glow', variants.glow);
}

document.getElementById('btn-toggle-auto-shading')?.addEventListener('click', () => {
  autoShadingMode = !autoShadingMode;
  document.getElementById('btn-toggle-auto-shading').classList.toggle('active', autoShadingMode);
  const bar = document.getElementById('smart-shading-bar');
  if (bar) bar.classList.toggle('shading-bar-hidden', !autoShadingMode);
  if (autoShadingMode) updateSmartShadingBar();
});

//  BRUSH UI
// ══════════════════════════════════════════
const brushSizeSlider = document.getElementById('brush-size');
const brushOpSlider   = document.getElementById('brush-opacity');
const brushFlowSlider = document.getElementById('brush-flow');
const brushSmoothSlider = document.getElementById('brush-smooth');

brushSizeSlider.addEventListener('input', e => { brush.setSize(+e.target.value); updateSizeIndicator(); updateBrushPreview(); });
brushOpSlider.addEventListener('input', e => { brush.setOpacity(+e.target.value / 100); updateBrushPreview(); });
brushFlowSlider.addEventListener('input', e => { brush.setFlow(+e.target.value / 100); updateBrushPreview(); });
brushSmoothSlider.addEventListener('input', e => { brush.setSmoothing(+e.target.value / 100); document.getElementById('brush-smooth-val').textContent = `${e.target.value}%`; });

// -- New Pro Settings Listeners --
const bHardSlider = document.getElementById('brush-hardness');
const bShapeSelect = document.getElementById('brush-shape');
const bGrainSelect = document.getElementById('brush-grain');
const bGrainScale = document.getElementById('brush-grain-scale');
const bGrainBright = document.getElementById('brush-grain-bright');

bHardSlider?.addEventListener('input', e => { 
  brush.setHardness(+e.target.value / 100); 
  document.getElementById('brush-hardness-val').textContent = `${e.target.value}%`;
  updateBrushPreview(); 
});
bShapeSelect?.addEventListener('change', e => { brush.setShape(e.target.value); updateBrushPreview(); });
bGrainSelect?.addEventListener('change', e => { brush.setGrain(e.target.value); updateBrushPreview(); });
bGrainScale?.addEventListener('input', e => { 
  brush.setGrainScale(+e.target.value / 100); 
  document.getElementById('brush-grain-scale-val').textContent = `${e.target.value}%`;
  updateBrushPreview(); 
});
bGrainBright?.addEventListener('input', e => { 
  brush.setGrainBrightness(+e.target.value); 
  document.getElementById('brush-grain-bright-val').textContent = e.target.value;
  updateBrushPreview(); 
});

document.getElementById('btn-reset-brush')?.addEventListener('click', () => {
  brush.applyPreset(brush.settings.preset || 'pencil-hb');
  syncBrushUI();
  updateBrushPreview();
});

const brushSilkSlider = document.getElementById('brush-silk');
const brushTaperSlider = document.getElementById('brush-taper');
const qsDwellSlider = document.getElementById('quicksnap-dwell');

brushSilkSlider.addEventListener('input', e => { brush.settings.silkWeight = +e.target.value / 100; document.getElementById('brush-silk-val').textContent = `${e.target.value}%`; });
brushTaperSlider.addEventListener('input', e => { brush.settings.velocityTaper = +e.target.value / 100; document.getElementById('brush-taper-val').textContent = `${e.target.value}%`; });
qsDwellSlider.addEventListener('input', e => { window._qsDwell = +e.target.value; document.getElementById('quicksnap-dwell-val').textContent = `${e.target.value}ms`; });

// ══════════════════════════════════════════
//  BRUSH BOTTOM SHEET — Artify-style
// ══════════════════════════════════════════

(function initBrushSheet() {
  const sheet      = document.getElementById('brush-bottom-sheet');
  const backdrop   = document.getElementById('brush-sheet-backdrop');
  const grid       = document.getElementById('brush-sheet-grid');
  const handle     = document.getElementById('brush-sheet-handle');
  const closeBtn   = document.getElementById('brush-sheet-close');
  const tabs       = document.getElementById('brush-sheet-tabs');
  const openBtn    = document.getElementById('btn-brush-library');
  const bsSizeSlider    = document.getElementById('bs-size');
  const bsSizeVal       = document.getElementById('bs-size-val');
  const bsOpacitySlider = document.getElementById('bs-opacity');
  const bsOpacityVal    = document.getElementById('bs-opacity-val');
  const bsColorBtn      = document.getElementById('bs-color-btn');

  if (!sheet) return;

  // ── Preview Canvas Cache ──
  const previewCache = new Map();

  function drawBrushPreview(canvas, presetKey, preset) {
    if (previewCache.has(presetKey)) {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(previewCache.get(presetKey), 0, 0);
      return;
    }

    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Dark background
    ctx.fillStyle = '#0e0e12';
    ctx.fillRect(0, 0, w, h);

    const color = preset.previewColor || '#ffffff';
    const steps = 28;
    const useTwoColors = preset.composite === 'lighter' || preset.category === 'effects';

    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const px = w * 0.06 + t * w * 0.88;
      const py = h * 0.5 + Math.sin(t * Math.PI) * h * 0.28;
      const pressure = 0.3 + Math.sin(t * Math.PI) * 0.7;

      let drawColor = color;
      if (useTwoColors) {
        // gradient effect for neon / airbrush
        const hex1 = color;
        const hex2 = preset.previewColor2 || '#ff6ec7';
        const lerpHex = (ca, cb, f) => {
          const ph = c => parseInt(c, 16);
          const rA = ph(ca.slice(1,3)), gA = ph(ca.slice(3,5)), bA = ph(ca.slice(5,7));
          const rB = ph(cb.slice(1,3)), gB = ph(cb.slice(3,5)), bB = ph(cb.slice(5,7));
          const rr = Math.round(rA + (rB-rA)*f);
          const gg = Math.round(gA + (gB-gA)*f);
          const bb = Math.round(bA + (bB-bA)*f);
          return `#${rr.toString(16).padStart(2,'0')}${gg.toString(16).padStart(2,'0')}${bb.toString(16).padStart(2,'0')}`;
        };
        drawColor = lerpHex(hex1, hex2, t);
      }

      // Parse color
      const hex = drawColor.replace('#','');
      const r = parseInt(hex.slice(0,2)||'ff',16);
      const g = parseInt(hex.slice(2,4)||'ff',16);
      const b = parseInt(hex.slice(4,6)||'ff',16);

      const hardness = preset.hardness ?? 0.7;
      const baseSize = Math.min(h * 0.4, Math.max(3, (preset.size || 12) * 0.55));
      const sz = baseSize * (0.3 + pressure * 0.7);
      const alpha = (preset.opacity ?? 0.9) * (preset.flow ?? 0.9) * (0.4 + pressure * 0.6);

      if (preset.composite === 'lighter') {
        ctx.globalCompositeOperation = 'lighter';
      } else {
        ctx.globalCompositeOperation = 'source-over';
      }

      if (preset.shape === 'splatter' || preset.scatter > 0) {
        // Splatter dots
        const dots = 4;
        for (let d = 0; d < dots; d++) {
          const ox = (Math.random() - 0.5) * sz * 2;
          const oy = (Math.random() - 0.5) * sz * 2;
          ctx.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
          ctx.beginPath();
          ctx.arc(px + ox, py + oy, sz * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${b},1)`;
          ctx.fill();
        }
      } else if (preset.shape === 'nib' || preset.shape === 'flat') {
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(px, py);
        const ar = preset.aspectRatio ?? 0.2;
        ctx.scale(ar < 0.5 ? ar * 2.5 : 1, 1);
        const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, sz);
        grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
        grd.addColorStop(hardness, `rgba(${r},${g},${b},${0.5})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.ellipse(0, 0, sz, sz * (ar < 0.5 ? 0.35 : 0.7), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // Round brush
        ctx.globalAlpha = alpha;
        const grd = ctx.createRadialGradient(px, py, 0, px, py, sz);
        grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
        grd.addColorStop(hardness, `rgba(${r},${g},${b},${0.4})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.5, sz), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Cache it
    const cached = document.createElement('canvas');
    cached.width = w; cached.height = h;
    cached.getContext('2d').drawImage(canvas, 0, 0);
    previewCache.set(presetKey, cached);
  }

  function renderGrid(cat) {
    grid.innerHTML = '';
    const entries = Object.entries(BrushEngine.CATALOG)
      .filter(([, p]) => cat === 'all' || p.category === cat);

    entries.forEach(([key, preset]) => {
      const card = document.createElement('div');
      card.className = 'bs-card';
      card.dataset.preset = key;
      if (key === brush.settings.preset) card.classList.add('active');

      const canvas = document.createElement('canvas');
      canvas.className = 'bs-card-preview';
      const dpr = window.devicePixelRatio || 1;
      canvas.width = 120 * dpr;
      canvas.height = 60 * dpr;
      canvas.style.width = '120px';
      canvas.style.height = '60px';

      const label = document.createElement('div');
      label.className = 'bs-card-label';
      label.textContent = preset.label;

      card.appendChild(canvas);
      card.appendChild(label);
      grid.appendChild(card);

      // Draw preview lazily using IntersectionObserver
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            drawBrushPreview(canvas, key, preset);
            observer.disconnect();
          }
        });
      }, { threshold: 0.1 });
      observer.observe(card);

      card.addEventListener('click', () => {
        grid.querySelectorAll('.bs-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        brush.applyPreset(key);
        syncBrushUI();
        // Sync bottom sheet sliders
        syncSheetSliders();
        // Haptic feedback on mobile
        if (navigator.vibrate) navigator.vibrate(10);
      });
    });
  }

  function syncSheetSliders() {
    const sz = Math.round(brush.settings.size);
    const op = Math.round(brush.settings.opacity * 100);
    if (bsSizeSlider) {
      bsSizeSlider.value = sz;
      bsSizeVal.textContent = sz;
      bsSizeSlider.style.setProperty('--val', (sz / 200 * 100) + '%');
    }
    if (bsOpacitySlider) {
      bsOpacitySlider.value = op;
      bsOpacityVal.textContent = op + '%';
      bsOpacitySlider.style.setProperty('--val', op + '%');
    }
    if (bsColorBtn) bsColorBtn.style.background = brush.color || '#000000';
  }

  // ── Open / Close ──
  let isOpen = false;

  function openSheet() {
    isOpen = true;
    sheet.classList.add('open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
    syncSheetSliders();
    // Highlight active preset
    grid.querySelectorAll('.bs-card').forEach(c => {
      c.classList.toggle('active', c.dataset.preset === brush.settings.preset);
    });
  }

  function closeSheet() {
    isOpen = false;
    sheet.classList.remove('open');
    backdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  openBtn?.addEventListener('click', () => {
    if (isOpen) closeSheet(); else openSheet();
  });
  closeBtn?.addEventListener('click', closeSheet);
  backdrop?.addEventListener('click', closeSheet);

  // ── Swipe / Drag to Close ──
  let dragStartY = 0, dragCurrentY = 0, isDragging = false;

  function onDragStart(y) {
    isDragging = true;
    dragStartY = y;
    dragCurrentY = y;
    sheet.style.transition = 'none';
  }
  function onDragMove(y) {
    if (!isDragging) return;
    dragCurrentY = y;
    const delta = Math.max(0, y - dragStartY);
    sheet.style.transform = `translateY(${delta}px)`;
  }
  function onDragEnd(y) {
    if (!isDragging) return;
    isDragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    const delta = y - dragStartY;
    if (delta > 100) closeSheet();
  }

  handle.addEventListener('touchstart', e => onDragStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove',  e => onDragMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener('touchend',   e => onDragEnd(e.changedTouches[0].clientY), { passive: true });
  handle.addEventListener('mousedown', e => onDragStart(e.clientY));
  window.addEventListener('mousemove', e => { if (isDragging) onDragMove(e.clientY); });
  window.addEventListener('mouseup',   e => { if (isDragging) onDragEnd(e.clientY); });

  // ── Category Tabs ──
  tabs?.querySelectorAll('.bs-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.bs-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderGrid(btn.dataset.cat);
    });
  });

  // ── Size Slider ──
  bsSizeSlider?.addEventListener('input', e => {
    const v = +e.target.value;
    brush.setSize(v);
    bsSizeVal.textContent = v;
    bsSizeSlider.style.setProperty('--val', (v / 200 * 100) + '%');
    // sync main sidebar slider too
    const mainSlider = document.getElementById('brush-size');
    if (mainSlider) { mainSlider.value = v; document.getElementById('brush-size-val').textContent = v + 'px'; }
    updateSizeIndicator();
    updateBrushPreview();
  });

  // ── Opacity Slider ──
  bsOpacitySlider?.addEventListener('input', e => {
    const v = +e.target.value;
    brush.setOpacity(v / 100);
    bsOpacityVal.textContent = v + '%';
    bsOpacitySlider.style.setProperty('--val', v + '%');
    const mainSlider = document.getElementById('brush-opacity');
    if (mainSlider) mainSlider.value = v;
    updateBrushPreview();
  });

  // ── Color Button — opens sidebar color panel ──
  bsColorBtn?.addEventListener('click', () => {
    closeSheet();
    openPanel('colors');
  });

  // ── Keep color button in sync ──
  const origSyncColorUI = window.syncColorUI;
  window.syncColorUI = function(...args) {
    if (origSyncColorUI) origSyncColorUI.apply(this, args);
    if (bsColorBtn) bsColorBtn.style.background = brush.color || '#000000';
  };

  // ── Initial render (all brushes) ──
  renderGrid('all');
  syncSheetSliders();

  // ── Also open sheet when tapping the brush tool button (double-tap logic) ──
  let brushBtnTapTime = 0;
  document.getElementById('tool-brush')?.addEventListener('click', () => {
    const now = Date.now();
    if (now - brushBtnTapTime < 400) openSheet();
    brushBtnTapTime = now;
  });

  // ── Public API ──
  window._brushSheet = { open: openSheet, close: closeSheet, sync: syncSheetSliders };
})();

// ── Old sidebar brush library (keep for desktop panel) ──
const renderBrushLibrary = (cat) => {
  const lib = document.getElementById('brush-library');
  if (!lib) return;
  lib.innerHTML = '';
  Object.entries(BrushEngine.CATALOG).filter(([, p]) => p.category === cat).forEach(([key, preset]) => {
    const item = document.createElement('div');
    item.className = 'brush-lib-item';
    item.textContent = preset.emoji + ' ' + preset.label;
    item.addEventListener('click', () => { brush.applyPreset(key); syncBrushUI(); });
    lib.appendChild(item);
  });
};
document.querySelectorAll('.bcat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bcat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderBrushLibrary(btn.dataset.cat);
  });
});

function updateSizeIndicator() {
  const ind = document.getElementById('size-indicator');
  if (ind) ind.style.width = ind.style.height = Math.max(6, Math.min(40, brush.settings.size)) + 'px';
}
function updateBrushPreview() {
  brush.renderPreview(document.getElementById('brush-preview'));
}

function syncBrushUI() {
  if (!brush.settings) return;
  
  // Basic Sliders
  if (brushSizeSlider) brushSizeSlider.value = brush.settings.size;
  if (brushOpSlider)   brushOpSlider.value = Math.round(brush.settings.opacity * 100);
  if (brushFlowSlider) brushFlowSlider.value = Math.round(brush.settings.flow * 100);
  if (brushSmoothSlider) {
    brushSmoothSlider.value = Math.round(brush.settings.smoothing * 100);
    document.getElementById('brush-smooth-val').textContent = `${brushSmoothSlider.value}%`;
  }
  
  // Pro Settings
  if (bHardSlider) {
    bHardSlider.value = Math.round(brush.settings.hardness * 100);
    document.getElementById('brush-hardness-val').textContent = `${bHardSlider.value}%`;
  }
  if (bShapeSelect) bShapeSelect.value = brush.settings.shape;
  if (bGrainSelect) bGrainSelect.value = brush.settings.grain;
  if (bGrainScale) {
    bGrainScale.value = Math.round(brush.settings.grainScale * 100);
    document.getElementById('brush-grain-scale-val').textContent = `${bGrainScale.value}%`;
  }
  if (bGrainBright) {
    bGrainBright.value = brush.settings.grainBrightness;
    document.getElementById('brush-grain-bright-val').textContent = bGrainBright.value;
  }
  
  // Silk & Taper
  if (brushSilkSlider) {
    brushSilkSlider.value = Math.round(brush.settings.silkWeight * 100);
    document.getElementById('brush-silk-val').textContent = `${brushSilkSlider.value}%`;
  }
  if (brushTaperSlider) {
    brushTaperSlider.value = Math.round(brush.settings.velocityTaper * 100);
    document.getElementById('brush-taper-val').textContent = `${brushTaperSlider.value}%`;
  }

  updateSizeIndicator();
  updateBrushPreview();
}

// ══════════════════════════════════════════
//  PANELS & LAYERS
// ══════════════════════════════════════════
document.getElementById('btn-add-layer').addEventListener('click', () => layersMgr.addLayer());
function openPanel(id) {
  document.querySelectorAll('.panel-tab, .panel-content').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-panel="${id}"]`)?.classList.add('active');
  document.getElementById(`panel-${id}`)?.classList.add('active');
  document.getElementById('right-panel').classList.add('open');
}
document.querySelectorAll('.panel-tab').forEach(tab => tab.addEventListener('click', () => openPanel(tab.dataset.panel)));

// ── Artboard & Page Manager UI ──
function renderPageList() {
  const list = document.getElementById('page-list');
  if (!list) return;
  list.innerHTML = '';
  engine.artboards.forEach((ab, idx) => {
    const thumb = document.createElement('div');
    thumb.className = `page-thumb ${idx === engine.activeArtboardIndex ? 'active' : ''}`;
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ab.name;
    thumb.appendChild(nameSpan);

    // Delete button (only if more than 1 page)
    if (engine.artboards.length > 1) {
      const delBtn = document.createElement('div');
      delBtn.className = 'page-delete';
      delBtn.innerHTML = '<i class="fas fa-times"></i>';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete artboard "${ab.name}"?`)) {
          engine.deleteArtboard(idx);
          renderPageList();
          layersMgr.render();
          showToast('Artboard Deleted');
        }
      };
      thumb.appendChild(delBtn);
    }

    thumb.onclick = () => {
      engine.switchPage(idx);
      renderPageList();
      layersMgr.render();
    };

    thumb.ondblclick = (e) => {
      e.stopPropagation();
      const newName = prompt('Enter new name for artboard:', ab.name);
      if (newName && newName.trim()) {
        engine.renameArtboard(idx, newName.trim());
        renderPageList();
      }
    };

    list.appendChild(thumb);
  });
}

document.getElementById('btn-add-page')?.addEventListener('click', () => {
  engine.addPage();
  renderPageList();
  showToast(`${engine.getActiveArtboard().name} Added`, 'success');
});

document.getElementById('btn-subview')?.addEventListener('click', () => {
  subview.toggle();
  document.getElementById('btn-subview').classList.toggle('active', subview.isVisible);
});

// ── Selection Toolbar Actions ──
const selToolbar = document.getElementById('selection-toolbar');
const hideSelToolbar = () => selToolbar?.classList.add('hidden');

document.getElementById('sel-cut')?.addEventListener('click', () => {
  engine.copySelection();
  engine.clearSelection();
  hideSelToolbar();
  showToast('Cut to Clipboard');
});
document.getElementById('sel-copy')?.addEventListener('click', () => {
  engine.copySelection();
  showToast('Copied to Clipboard');
});
document.getElementById('sel-paste')?.addEventListener('click', () => {
  engine.pasteSelection();
  resetSelSliders();
  selToolbar?.classList.remove('hidden');
  showToast('Pasted from Clipboard');
});
document.getElementById('sel-commit')?.addEventListener('click', () => {
  engine.commitSelection();
  hideSelToolbar();
  showToast('Selection Committed', 'success');
});
document.getElementById('sel-clear')?.addEventListener('click', () => {
  engine.clearSelection();
  hideSelToolbar();
  showToast('Selection Cleared');
});

const selScale = document.getElementById('sel-scale');
const selRotate = document.getElementById('sel-rotate');

selScale?.addEventListener('input', (e) => {
  if (engine.selection.active) {
    engine.selection.transform.scale = parseFloat(e.target.value);
    engine.markDirty();
  }
});

selRotate?.addEventListener('input', (e) => {
  if (engine.selection.active) {
    engine.selection.transform.rotation = parseFloat(e.target.value) * Math.PI / 180;
    engine.markDirty();
  }
});

function resetSelSliders() {
  if (selScale) selScale.value = 1;
  if (selRotate) selRotate.value = 0;
}

// Zen Mode logic moved to InputHandler callback

// ══════════════════════════════════════════
//  ZOOM & UNDO
// ══════════════════════════════════════════
function updateZoomUI(scale) {
  const indicator = document.getElementById('zoom-indicator');
  if (indicator) indicator.textContent = Math.round(scale * 100) + '%';
}
document.getElementById('btn-zoom-in')?.addEventListener('click', () => { engine.zoomAt(engine.viewW/2, engine.viewH/2, 1.25); updateZoomUI(engine.scale); });
document.getElementById('btn-zoom-out')?.addEventListener('click', () => { engine.zoomAt(engine.viewW/2, engine.viewH/2, 0.8); updateZoomUI(engine.scale); });
document.getElementById('btn-zoom-reset')?.addEventListener('click', () => { engine.resetView(); updateZoomUI(1); });
document.getElementById('btn-undo')?.addEventListener('click', () => { undo.undo(); engine.markDirty(); });
document.getElementById('btn-redo')?.addEventListener('click', () => { undo.redo(); engine.markDirty(); });

// ── Global Keyboard Shortcuts ──
window.addEventListener('keydown', (e) => {
  // Selection Shortcuts
  if (engine.selection.active) {
    if (e.key === 'Escape') { engine.clearSelection(); hideSelToolbar(); showToast('Selection Cleared'); }
    if (e.key === 'Enter') { engine.commitSelection(); hideSelToolbar(); showToast('Selection Committed', 'success'); }
    
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c') { engine.copySelection(); showToast('Copied to Clipboard'); }
      if (e.key === 'x') { engine.copySelection(); engine.clearSelection(); hideSelToolbar(); showToast('Cut to Clipboard'); }
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    engine.pasteSelection();
    resetSelSliders();
    selToolbar?.classList.remove('hidden');
    showToast('Pasted from Clipboard');
  }

  // Artboard Switching (1-9)
  if (!isNaN(e.key) && e.key >= 1 && e.key <= 9) {
    const idx = parseInt(e.key) - 1;
    if (engine.artboards[idx]) {
      engine.switchPage(idx);
      renderPageList();
      layersMgr.render();
      showToast(`Switched to ${engine.artboards[idx].name}`);
    }
  }
});

// ══════════════════════════════════════════
//  INITIALIZE
// ══════════════════════════════════════════
renderBrushLibrary('arabic');
updateSizeIndicator();
updateBrushPreview();
setTool('brush');
renderPageList();
showToast('🎨 DrawFlow V5 Ready');

// ══════════════════════════════════════════
//  EXPORT MODAL
// ══════════════════════════════════════════
document.getElementById('btn-export')?.addEventListener('click', () => {
  document.getElementById('export-modal').classList.remove('hidden');
});
document.getElementById('export-modal-close')?.addEventListener('click', () => {
  document.getElementById('export-modal').classList.add('hidden');
});
document.getElementById('export-modal')?.querySelector('.modal-overlay')?.addEventListener('click', () => {
  document.getElementById('export-modal').classList.add('hidden');
});
document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const fmt = btn.dataset.format;
    showToast(`⏳ Exporting as ${fmt.toUpperCase()}...`, 'info', 1500);
    try {
      const dataUrl = await engine.exportCanvas(fmt, 0.95);
      const a = document.createElement('a');
      const fname = (document.getElementById('project-name')?.textContent?.trim() || 'drawing').replace(/[^a-z0-9_-]/gi, '_');
      a.download = `${fname}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
      a.href = dataUrl;
      document.body.appendChild(a);
      a.click();
      a.remove();
      document.getElementById('export-modal').classList.add('hidden');
      showToast(`✅ Exported as ${fmt.toUpperCase()}`, 'success');
    } catch (e) {
      showToast('❌ Export failed: ' + e.message, 'error');
    }
  });
});

// Old collab modal handlers removed — all collab logic lives in initMobileAndCollab() below

// ══════════════════════════════════════════
//  CANVAS PALETTE & REALISM
// ══════════════════════════════════════════
let paletteModal, colorsGrid, shadingSection;

window._isShadingMode = false;
window._shadingBaseColor = '#000000';
window._shadingTargetColor = '#000000';

function enterShadingMode(baseColor, targetColor) {
   window._isShadingMode = true;
   window._shadingBaseColor = baseColor;
   window._shadingTargetColor = targetColor;
   setTool('brush'); // Switches cursor but we hook into gradient logic
   paletteModal.style.display = 'none';
   
   // Show a small notification toast
   showToast("Select area to shade & drag arrow", "linear-gradient(to right, #4338ca, #6366f1)");
}

function exitShadingMode() {
   window._isShadingMode = false;
}


function generateShadingVariants(hex) {
    const hsl = color.hexToHsl(hex);
    const container = document.getElementById('shading-variants');
    if (!container) return;
    container.innerHTML = '';

    // Professional range: Deeper shadows, brighter Highlights
    const variations = [
        { l: -35, s: 20, label: 'Shadow' },
        { l: -15, s: 10, label: 'Mid' },
        { l: 15, s: -5, label: 'Light' },
        { l: 40, s: -15, label: 'Highlight' }
    ];

    variations.forEach(v => {
        const h = hsl.h;
        const s = Math.max(0, Math.min(100, hsl.s + v.s));
        const l = Math.max(0, Math.min(100, hsl.l + v.l));
        const vHex = color.hslToHex(h, s, l);

        const card = document.createElement('div');
        card.className = 'shading-card';
        card.innerHTML = `
            <div class="shading-swatch" style="background: ${vHex}"></div>
            <div class="shading-label">${v.label}</div>
        `;
        card.onclick = () => {
            enterShadingMode(hex, vHex);
        };
        container.appendChild(card);
    });
}

function initPaletteModal() {
  paletteModal = document.getElementById('palette-modal');
  colorsGrid = document.getElementById('canvas-colors-grid');
  shadingSection = document.getElementById('shading-variants-section');

  document.getElementById('palette-modal-close')?.addEventListener('click', () => paletteModal?.classList.add('hidden'));
  document.getElementById('btn-canvas-palette')?.addEventListener('click', openPaletteModal);
  paletteModal?.querySelector('.modal-overlay')?.addEventListener('click', () => paletteModal?.classList.add('hidden'));
}

// Ensure init runs
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPaletteModal);
} else {
  initPaletteModal();
}

function openPaletteModal() {
  if (!paletteModal) {
    initPaletteModal();
    if (!paletteModal) return;
  }
  paletteModal.classList.remove('hidden');
  colorsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 20px; color: #555; font-size: 12px;">Scanning canvas...</div>';
  
  // Wait a frame for UI to show "scanning"
  requestAnimationFrame(() => {
    const colors = PaletteExtractor.extract(engine);
    renderPaletteGrid(colors);
  });
}

function renderPaletteGrid(colors) {
  if (colors.length === 0) {
    colorsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 20px; color: #888; font-size: 12px;">No unique colors detected yet.</div>';
    return;
  }
  
  colorsGrid.innerHTML = colors.map(c => 
    `<div class="palette-swatch" style="background: ${c};" data-color="${c}"></div>`
  ).join('');

  colorsGrid.querySelectorAll('.palette-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const hex = sw.dataset.color;
      colorsGrid.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      showShadingVariants(hex);
    });
  });
}

function showShadingVariants(baseHex) {
  shadingSection.classList.remove('hidden');
  const variants = calculateShadingObject(baseHex);
  
  const setupVariant = (id, hex) => {
    const el = document.getElementById(id);
    const swatch = el.querySelector('.variant-swatch');
    swatch.style.background = hex;
    el.onclick = () => {
      color.setHex(hex);
      updateUIFromColor();
      paletteModal.classList.add('hidden');
      showToast('🎨 Realism variant selected', 'success');
    };
  };

  setupVariant('variant-deep-shadow', variants.deepShadow);
  setupVariant('variant-shadow', variants.shadow);
  setupVariant('variant-midtone', variants.midtone);
  setupVariant('variant-highlight', variants.highlight);
  setupVariant('variant-glow', variants.glow);
}

function calculateShadingObject(hex) {
  const tempCol = new ColorSystem();
  tempCol.setHex(hex);
  const { h, s, b } = tempCol;
  
  const adjust = (dh, ds, db) => {
    const res = new ColorSystem();
    res.h = (h + dh + 360) % 360;
    res.s = Math.max(0, Math.min(100, s + ds));
    res.b = Math.max(0, Math.min(100, b + db));
    return res.toHex();
  };

  return {
    deepShadow: adjust(5, 35, -45), // More aggressive shadow depth
    shadow:     adjust(3, 15, -25),
    midtone:    hex,
    highlight:  adjust(-3, -15, 30),
    glow:       adjust(-6, -25, 55)  // Brighter glow
  };
}

document.getElementById('btn-canvas-palette')?.addEventListener('click', openPaletteModal);
document.getElementById('palette-modal-close')?.addEventListener('click', () => paletteModal.classList.add('hidden'));
paletteModal?.querySelector('.modal-overlay')?.addEventListener('click', () => paletteModal.classList.add('hidden'));

// Helper to update other UI parts when color changes via code
function updateUIFromColor() {
  const hex = color.toHex();
  document.getElementById('color-swatch').style.backgroundColor = hex;
  document.getElementById('input-hex').value = hex.replace('#', '');
  // Update palette if exists
  updateBrushPreview();
}

// ══════════════════════════════════════════
//  MENU DRAWER
// ══════════════════════════════════════════
(function initMenu() {
  // Create drawer
  const drawer = document.createElement('div');
  drawer.id = 'menu-drawer';
  drawer.innerHTML = `
    <div class="menu-drawer-header">
      <span>🎨 DrawFlow</span>
      <button id="menu-drawer-close" class="icon-btn-small" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;">✕</button>
    </div>
    <div class="menu-section-label">Canvas Size</div>
    <div class="menu-canvas-sizes">
      <button class="menu-size-btn" data-w="1080" data-h="1080">1080×1080<br><small>Square</small></button>
      <button class="menu-size-btn" data-w="1920" data-h="1080">1920×1080<br><small>Landscape</small></button>
      <button class="menu-size-btn" data-w="1080" data-h="1920">1080×1920<br><small>Portrait</small></button>
      <button class="menu-size-btn active" data-w="2048" data-h="2048">2048×2048<br><small>Large</small></button>
      <button class="menu-size-btn" data-w="4096" data-h="4096">4096×4096<br><small>Hi-Res</small></button>
    </div>
    <div class="menu-section-label" style="margin-top:16px;">Actions</div>
    <div class="menu-actions">
      <button class="menu-action-btn" id="menu-clear-canvas">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        Clear Canvas
      </button>
      <button class="menu-action-btn" id="menu-flatten-layers">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18"/></svg>
        Flatten Layers
      </button>
      <button class="menu-action-btn" id="menu-new-canvas">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18"><path d="M12 5v14M5 12h14"/></svg>
        New Canvas
      </button>
    </div>
    <div class="menu-section-label" style="margin-top:16px;">Info</div>
    <div style="font-size:11px;color:#666;padding:0 4px;">
      DrawFlow V5 — Professional Drawing App<br>
      Keyboard: B=Brush E=Eraser G=Gradient T=Text<br>
      [ ] = Brush Size &nbsp;|&nbsp; Ctrl+Z = Undo
    </div>
  `;
  document.getElementById('app').appendChild(drawer);

  const overlay = document.createElement('div');
  overlay.id = 'menu-overlay';
  document.getElementById('app').appendChild(overlay);

  function openMenu() { drawer.classList.add('open'); overlay.classList.add('open'); }
  function closeMenu() { drawer.classList.remove('open'); overlay.classList.remove('open'); }

  document.getElementById('btn-menu')?.addEventListener('click', openMenu);
  document.getElementById('menu-drawer-close')?.addEventListener('click', closeMenu);
  overlay.addEventListener('click', closeMenu);

  // Canvas size buttons
  drawer.querySelectorAll('.menu-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = parseInt(btn.dataset.w), h = parseInt(btn.dataset.h);
      if (w === engine.docWidth && h === engine.docHeight) return;
      if (!confirm(`Resize canvas to ${w}×${h}? Current artwork will be preserved (may be cropped).`)) return;
      // Store current content
      const oldLayer = engine.getActiveLayer();
      const snapImg = new OffscreenCanvas(engine.docWidth, engine.docHeight);
      snapImg.getContext('2d').drawImage(oldLayer.canvas, 0, 0);
      // Resize all layers
      engine.docWidth = w; engine.docHeight = h;
      engine.layers.forEach(l => {
        const newCvs = new OffscreenCanvas(w, h);
        newCvs.getContext('2d').drawImage(l.canvas, 0, 0);
        l.canvas = newCvs;
        l.ctx = newCvs.getContext('2d');
      });
      engine._centerCanvas();
      engine.markDirty();
      layersMgr.render();
      drawer.querySelectorAll('.menu-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showToast(`📐 Canvas resized to ${w}×${h}`, 'success');
      closeMenu();
    });
  });

  // Clear canvas
  document.getElementById('menu-clear-canvas')?.addEventListener('click', () => {
    if (!confirm('Clear all content on the active layer?')) return;
    undo.snapshot('clear');
    const lctx = engine.getActiveCtx();
    if (lctx) lctx.clearRect(0, 0, engine.docWidth, engine.docHeight);
    engine.markDirty();
    showToast('🗑️ Layer cleared', 'info');
    closeMenu();
  });

  // Flatten layers
  document.getElementById('menu-flatten-layers')?.addEventListener('click', () => {
    if (engine.layers.length <= 1) { showToast('Only one layer — nothing to flatten', 'info'); return; }
    if (!confirm('Flatten all visible layers into one? This cannot be undone easily.')) return;
    undo.snapshot('flatten');
    const flat = new OffscreenCanvas(engine.docWidth, engine.docHeight);
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, engine.docWidth, engine.docHeight);
    engine._drawLayers(fctx);
    engine.layers = [{
      canvas: flat, ctx: fctx,
      name: 'Merged Layer 1',
      visible: true, locked: false, clipping: false,
      opacity: 1, blendMode: 'source-over', alphaLock: false,
      id: Date.now()
    }];
    engine.activeLayerIndex = 0;
    engine.markDirty();
    layersMgr.render();
    showToast('🗂️ Layers flattened', 'success');
    closeMenu();
  });

  // New canvas
  document.getElementById('menu-new-canvas')?.addEventListener('click', () => {
    if (!confirm('Start a new canvas? All current work will be lost.')) return;
    engine.layers = [];
    engine.addLayer('Background');
    engine.activeLayerIndex = 0;
    engine.markDirty();
    layersMgr.render();
    undo.clear();
    document.getElementById('project-name').textContent = 'Untitled Project';
    showToast('✨ New canvas created', 'success');
    closeMenu();
  });
})();

// ══════════════════════════════════════════
//  MOBILE & COLLAB UI HANDLERS
// ══════════════════════════════════════════
(function initMobileAndCollab() {
  const panelToggle = document.getElementById('mobile-panel-toggle');
  const rightPanel = document.getElementById('right-panel');
  const collabBtn = document.getElementById('btn-collab');
  const collabModal = document.getElementById('collab-modal');
  const collabClose = document.getElementById('collab-modal-close');
  
  // Mobile Panel Toggle
  panelToggle?.addEventListener('click', () => {
    panelToggle.classList.toggle('active');
    rightPanel?.classList.toggle('mobile-visible');
  });

  // Collaboration Modal open/close
  collabBtn?.addEventListener('click', () => {
    if (collabModal) collabModal.classList.remove('hidden');
  });
  collabClose?.addEventListener('click', () => {
    if (collabModal) collabModal.classList.add('hidden');
  });
  collabModal?.querySelector('.modal-overlay')?.addEventListener('click', () => {
    if (collabModal) collabModal.classList.add('hidden');
  });

  const disconnectedView = document.getElementById('collab-disconnected');
  const connectedView = document.getElementById('collab-connected');
  const codeDisplay = document.getElementById('session-code-value');
  const userList = document.getElementById('collab-user-list');

  // ── Host Session ──
  document.getElementById('btn-collab-host')?.addEventListener('click', () => {
    const code = CollabEngine.generateCode();
    if (codeDisplay) codeDisplay.textContent = code;
    const customIp = document.getElementById('input-collab-server')?.value?.trim() || null;
    collab.connect(code, true, customIp);
    showToast(`🤝 Session created: ${code}`, 'success');
  });

  // ── Join Session ──
  document.getElementById('btn-collab-join')?.addEventListener('click', () => {
    const codeInput = document.getElementById('input-collab-code');
    const code = codeInput?.value?.trim().toUpperCase() || '';
    if (code.length !== 6) {
      showToast('Enter a valid 6-character code', 'error');
      return;
    }
    if (codeDisplay) codeDisplay.textContent = code;
    const customIp = document.getElementById('input-collab-server')?.value?.trim() || null;
    collab.connect(code, false, customIp);
    showToast(`🔗 Joining session: ${code}`, 'info');
  });

  // ── Leave Session ──
  document.getElementById('btn-collab-leave')?.addEventListener('click', () => {
    collab.disconnect();
    updateCollabUI('disconnected');
    showToast('Left collaboration session', 'info');
  });

  // ── Copy Invite Link ──
  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    const code = collab.sessionCode || codeDisplay?.textContent || '';
    const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
    navigator.clipboard.writeText(url)
      .then(() => showToast('📋 Invite link copied!', 'success'))
      .catch(() => {
        // Fallback for mobile browsers
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        showToast('📋 Invite link copied!', 'success');
      });
  });

  // ── WhatsApp Share ──
  document.getElementById('btn-share-wa')?.addEventListener('click', () => {
    const code = collab.sessionCode || codeDisplay?.textContent || '';
    const text = `🎨 Join my drawing session! Room Code: ${code}`;
    
    if (navigator.share) {
      navigator.share({
        title: 'Drawing Session',
        text: text,
      }).catch(console.error);
    } else {
      const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
    }
  });

  // ── Update UI based on connection status ──
  function updateCollabUI(status) {
    const statusEl = document.getElementById('collab-status');
    const dot = statusEl?.querySelector('.status-dot');
    // Get the second span (text), not the first (dot)
    const textSpans = statusEl?.querySelectorAll('span');
    const text = textSpans && textSpans.length > 1 ? textSpans[1] : null;
    
    if (status === 'connected') {
      // Toggle modal views
      if (disconnectedView) disconnectedView.style.display = 'none';
      if (connectedView) {
        connectedView.classList.remove('hidden');
        connectedView.style.display = 'flex';
      }
      if (codeDisplay) codeDisplay.textContent = collab.sessionCode;
      if (dot) dot.className = 'status-dot connected';
      if (text) text.textContent = 'Live';
      showToast(`✅ Connected to room: ${collab.sessionCode}`, 'success');
    } else if (status === 'connecting') {
      if (dot) dot.className = 'status-dot connecting';
      if (text) text.textContent = 'Connecting...';
    } else {
      // disconnected
      if (disconnectedView) disconnectedView.style.display = 'flex';
      if (connectedView) {
        connectedView.classList.add('hidden');
        connectedView.style.display = 'none';
      }
      if (dot) dot.className = 'status-dot';
      if (text) text.textContent = 'Offline';
    }
  }

  // Wire up collab engine callbacks
  collab.onStatus = updateCollabUI;
  collab.onUsersChange = (users) => {
    if (!userList) return;
    userList.innerHTML = users.map(u => `
      <div class="collab-user-badge" style="background:${u.color}22; border:1px solid ${u.color}">
        <span style="color:${u.color}">●</span>
        <span>${u.name} ${u.userId === collab.userId ? '(You)' : ''}</span>
      </div>
    `).join('');
  };

  // Check URL for auto-join
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room && room.length === 6) {
    setTimeout(() => {
      collab.connect(room, false);
      if (collabModal) collabModal.classList.remove('hidden');
    }, 1000);
  }
})();
