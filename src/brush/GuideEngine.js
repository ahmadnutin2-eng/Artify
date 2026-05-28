/**
 * GuideEngine — Spatial Intelligence for Perspective & Symmetry
 * 
 * Provides coordinate projection and snapping for:
 *  - 1/2/3 Point Perspective
 *  - Mirror Symmetry (Vertical, Horizontal, Axis-based)
 *  - Radial Symmetry
 */

export class GuideEngine {
  constructor(canvasEngine) {
    this.engine = canvasEngine;
    
    this.perspectiveEnabled = false;
    this.perspectivePoints = [
      { x: 0, y: 0.5 },    // VP1 (Left)
      { x: 1, y: 0.5 },    // VP2 (Right)
      { x: 0.5, y: -1 }    // VP3 (Top/Bottom)
    ];
    this.perspectiveSnap = 0.1; // 0 to 1 intensity

    this.symmetryEnabled = false;
    this.symmetryType = 'mirror-v'; // 'mirror-v', 'mirror-h', 'radial'
    this.symmetryLines = 8;        // For radial
    this.symmetryOrigin = { x: 0.5, y: 0.5 }; // Normalized 0-1
  }

  /**
   * Project a raw point onto the active guide system
   * @returns {Object} { x, y, angle? }
   */
  project(x, y) {
    if (!this.perspectiveEnabled && !this.symmetryEnabled) return { x, y };

    let out = { x, y };

    if (this.perspectiveEnabled) {
      out = this._snapToPerspective(x, y);
    }

    return out;
  }

  /**
   * Get mirror/radial variants of a point for symmetry rendering
   * @returns {Array} List of {x, y} points
   */
  getSymmetryPoints(x, y) {
    if (!this.symmetryEnabled) return [{ x, y }];

    const points = [{ x, y }];
    const centerX = this.symmetryOrigin.x * this.engine.width;
    const centerY = this.symmetryOrigin.y * this.engine.height;

    if (this.symmetryType === 'mirror-v') {
      points.push({ x: 2 * centerX - x, y });
    } else if (this.symmetryType === 'mirror-h') {
      points.push({ x, y: 2 * centerY - y });
    } else if (this.symmetryType === 'radial') {
      const dx = x - centerX;
      const dy = y - centerY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const startAngle = Math.atan2(dy, dx);
      
      for (let i = 1; i < this.symmetryLines; i++) {
        const angle = startAngle + (i * 2 * Math.PI) / this.symmetryLines;
        points.push({
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius
        });
      }
    }

    return points;
  }

  _snapToPerspective(x, y) {
    if (!this.perspectiveEnabled) return { x, y };

    const w = this.engine.docWidth || this.engine.width;
    const h = this.engine.docHeight || this.engine.height;
    
    // Position of Vanishing Points (Responsive to canvas size)
    const vps = [];
    
    if (this.perspectiveType === '1') {
      vps.push({ x: 0.5 * w, y: 0.5 * h });
    } else if (this.perspectiveType === '2') {
      vps.push({ x: -0.2 * w, y: 0.4 * h });
      vps.push({ x: 1.2 * w,  y: 0.4 * h });
    } else { // 3-Point
      vps.push({ x: -0.3 * w, y: 0.5 * h });
      vps.push({ x: 1.3 * w,  y: 0.5 * h });
      vps.push({ x: 0.5 * w,  y: -0.8 * h }); // Vertical VP
    }

    let bestDist = Infinity;
    let snapped = { x, y };

    vps.forEach(vp => {
      const dx = x - vp.x;
      const dy = y - vp.y;
      const angle = Math.atan2(dy, dx);
      
      // Snap to radiate lines
      const step = (10 * Math.PI) / 180; // 10 degree increments
      const snappedAngle = Math.round(angle / step) * step;
      
      const dist = Math.hypot(dx, dy);
      const nx = vp.x + Math.cos(snappedAngle) * dist;
      const ny = vp.y + Math.sin(snappedAngle) * dist;

      const d = Math.hypot(nx - x, ny - y);
      if (d < bestDist && d < 30) {
        bestDist = d;
        snapped = { x: nx, y: ny };
      }
    });

    return snapped;
  }

  drawGuides(ctx) {
    if (!this.perspectiveEnabled && !this.symmetryEnabled) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.3)';
    ctx.lineWidth = 1 / this.engine.scale;

    const w = this.engine.width;
    const h = this.engine.height;

    if (this.symmetryEnabled) {
      const cx = this.symmetryOrigin.x * w;
      const cy = this.symmetryOrigin.y * h;

      if (this.symmetryType === 'mirror-v') {
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
      } else if (this.symmetryType === 'mirror-h') {
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
      } else if (this.symmetryType === 'radial') {
        for (let i = 0; i < this.symmetryLines; i++) {
          const angle = (i * 2 * Math.PI) / this.symmetryLines;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(angle) * w * 2, cy + Math.sin(angle) * w * 2);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }
}
