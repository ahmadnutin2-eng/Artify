/**
 * ShapeDetector Utility
 * 
 * Analyzes an array of points to determine if they resemble a basic shape.
 * Used for "QuickSnap" (holding at the end of a stroke to perfect the shape).
 */
export class ShapeDetector {
  /**
   * Detects the shape type from a set of points.
   * Returns { type: 'circle'|'rectangle'|'triangle'|'line'|null, score: 0-1, bounds: {} }
   */
  static detect(points) {
    if (points.length < 10) return null;

    const bounds = this._getBounds(points);
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;
    const center = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };

    if (width < 5 || height < 5) return null;

    // Check if it's a closed or nearly closed shape
    const start = points[0];
    const end = points[points.length - 1];
    const distToStart = Math.hypot(end.x - start.x, end.y - start.y);
    const isClosed = distToStart < Math.max(width, height) * 0.3;

    // 1. Check for Circle
    const circleResult = this._testCircle(points, center, (width + height) / 4);
    if (circleResult.score > 0.85) return { type: 'circle', ...circleResult, bounds };

    // 2. Check for Rectangle
    const rectResult = this._testRectangle(points, bounds);
    if (rectResult.score > 0.8) return { type: 'rectangle', ...rectResult, bounds };

    // 3. Check for Triangle
    const triResult = this._testTriangle(points, bounds);
    if (triResult.score > 0.8) return { type: 'triangle', ...triResult, bounds };

    // 4. Check for Star
    const starResult = this._testStar(points, center);
    if (starResult.score > 0.75) return { type: 'star', ...starResult, bounds };

    // 5. Check for Line
    const lineResult = this._testLine(points);
    if (lineResult.score > 0.95) return { type: 'line', ...lineResult, bounds };

    return null;
  }

  static _getBounds(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }

  static _testCircle(points, center, radius) {
    let totalError = 0;
    for (const p of points) {
      const dist = Math.hypot(p.x - center.x, p.y - center.y);
      totalError += Math.abs(dist - radius) / radius;
    }
    const avgError = totalError / points.length;
    return { score: Math.max(0, 1 - avgError * 2), center, radius };
  }

  static _testRectangle(points, bounds) {
    // Check coverage of the bounding box
    const w = bounds.max.x - bounds.min.x;
    const h = bounds.max.y - bounds.min.y;
    
    // Simple heuristic: distance to nearest edge of BBox
    let totalError = 0;
    for (const p of points) {
      const dLeft = Math.abs(p.x - bounds.min.x);
      const dRight = Math.abs(p.x - bounds.max.x);
      const dTop = Math.abs(p.y - bounds.min.y);
      const dBottom = Math.abs(p.y - bounds.max.y);
      totalError += Math.min(dLeft, dRight, dTop, dBottom) / ((w + h) / 4);
    }
    const avgError = totalError / points.length;
    const center = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
    return { score: Math.max(0, 1 - avgError * 1.5), center };
  }

  static _testLine(points) {
    const start = points[0];
    const end = points[points.length - 1];
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist < 5) return { score: 0 };

    let totalError = 0;
    for (const p of points) {
      // Distance from point to line segment
      const d = this._distToSegment(p, start, end);
      totalError += d;
    }
    const avgError = totalError / points.length;
    const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return { score: Math.max(0, 1 - avgError / 10), x1: start.x, y1: start.y, x2: end.x, y2: end.y, center };
  }

  static _distToSegment(p, v, w) {
    const l2 = Math.pow(w.x - v.x, 2) + Math.pow(w.y - v.y, 2);
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  }

  static _testTriangle(points, bounds) {
    if (points.length < 15) return { score: 0 };
    const center = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
    
    // Find 3 vertices by getting points furthest from center at different angles
    const verts = [];
    for (let i = 0; i < 3; i++) {
        const targetAngle = (i * Math.PI * 2) / 3;
        let bestP = points[0];
        let maxD = -1;
        for (const p of points) {
            const angle = Math.atan2(p.y - center.y, p.x - center.x);
            const dist = Math.hypot(p.x - center.x, p.y - center.y);
            const score = dist * Math.cos(angle - targetAngle);
            if (score > maxD) {
                maxD = score;
                bestP = p;
            }
        }
        verts.push(bestP);
    }

    // Check if points are close to the triangle edges
    let totalError = 0;
    for (const p of points) {
        const d1 = this._distToSegment(p, verts[0], verts[1]);
        const d2 = this._distToSegment(p, verts[1], verts[2]);
        const d3 = this._distToSegment(p, verts[2], verts[0]);
        totalError += Math.min(d1, d2, d3);
    }
    
    const avgError = totalError / points.length;
    const size = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
    const score = Math.max(0, 1 - (avgError / (size * 0.1)));
    
    if (score > 0.75) {
        return { score, type: 'triangle', vertices: verts, center };
    }
    return { score: 0 };
  }

  static _testStar(points, center) {
    if (points.length < 20) return { score: 0 };
    // Refined Star detection: 5 points furthest from center, 5 points closest
    // Check for radial oscillation (5 peaks, 5 valleys)
    let transitions = 0;
    let lastDir = 0; 
    const distances = points.map(p => Math.hypot(p.x - center.x, p.y - center.y));
    const smoothDist = [];
    for (let i = 2; i < distances.length - 2; i++) {
        smoothDist.push((distances[i-2] + distances[i-1] + distances[i] + distances[i+1] + distances[i+2]) / 5);
    }
    
    for (let i = 1; i < smoothDist.length; i++) {
        const dir = Math.sign(smoothDist[i] - smoothDist[i-1]);
        if (dir !== 0 && dir !== lastDir) {
            transitions++;
            lastDir = dir;
        }
    }
    
    // A 5-pointed star has 10 segments (5 in, 5 out) => ~10 transitions
    const score = (transitions >= 8 && transitions <= 12) ? 0.85 : 0;
    return { score, type: 'star', center };
  }
}
