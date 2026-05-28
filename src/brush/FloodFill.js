/**
 * FloodFill — Optimized Span-Fill with Smart Gap Closing
 *
 * Gap Fill Strategy (gapFill > 0):
 *   1. Detect all stroke/edge pixels in the source image.
 *   2. Dilate them by `gapFill` pixels using a fast O(n) prefix-sum approach.
 *   3. During fill, treat dilated stroke pixels as solid walls.
 *   → Small gaps in shapes get sealed → interior fills correctly.
 *   → Large open areas still fill normally (no fake walls added).
 */

export class FloodFill {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} startX
   * @param {number} startY
   * @param {number} width
   * @param {number} height
   * @param {string} fillColorHex  — '#RRGGBB'
   * @param {number} tolerance     — 0-100
   * @param {number} gapFill       — 0-20 (pixels to dilate strokes to close gaps)
   * @returns {HTMLCanvasElement|null}
   */
  static computeFillMask(
    ctx, startX, startY,
    width, height,
    fillColorHex,
    tolerance = 15,
    gapFill = 0,
    expansion = 0
  ) {
    startX = Math.max(0, Math.min(width - 1, Math.floor(startX)));
    startY = Math.max(0, Math.min(height - 1, Math.floor(startY)));

    const imgData = ctx.getImageData(0, 0, width, height);
    const data32  = new Uint32Array(imgData.data.buffer);

    const startIdx   = startY * width + startX;
    const startColor = data32[startIdx];

    // ── Parse fill colour ──
    const hex = fillColorHex.replace('#', '');
    const fr = parseInt(hex.substring(0, 2), 16);
    const fg = parseInt(hex.substring(2, 4), 16);
    const fb = parseInt(hex.substring(4, 6), 16);

    // ── Tolerance (squared distance in RGBA space) ──
    const maxDiff = (tolerance / 100) * 255;
    const tolSq   = maxDiff * maxDiff * 4;

    const tr = startColor        & 0xFF;
    const tg = (startColor >>  8) & 0xFF;
    const tb = (startColor >> 16) & 0xFF;
    const ta = (startColor >> 24) & 0xFF;

    // ── Build dilated block map for gap closing ──
    let blocked = null;
    if (gapFill > 0) {
      blocked = FloodFill._buildDilatedBlockMap(data32, width, height, Math.round(gapFill));
      // The fill start point must never be blocked
      blocked[startIdx] = 0;
    }

    // ── Color match predicate ──
    const canFill = (idx) => {
      // Dilated stroke walls act as hard boundaries ONLY for navigation,
      // but we allow the fill to sample them if they aren't fully opaque.
      if (blocked !== null && blocked[idx]) return false;

      const c  = data32[idx];
      const a  = (c >> 24) & 0xFF;
      
      // If the target area is almost transparent, we're more lenient
      if (ta < 10 && a < 10) return true;

      const dr = (c        & 0xFF) - tr;
      const dg = ((c >>  8) & 0xFF) - tg;
      const db = ((c >> 16) & 0xFF) - tb;
      const da = (a - ta);
      
      return (dr*dr + dg*dg + db*db + da*da) <= tolSq;
    };

    // ── Span-fill (queue-based) ──
    const maskData = new Uint8ClampedArray(width * height * 4);
    const visited  = new Uint8Array(width * height);
    const stack    = new Int32Array(width * height * 2);
    let head = 0;

    stack[head++] = startX;
    stack[head++] = startY;

    let minX = width, minY = height, maxX = 0, maxY = 0;

    while (head > 0) {
      let y   = stack[--head];
      let x   = stack[--head];
      let idx = y * width + x;

      // Scan upward
      while (y >= 0 && canFill(idx) && !visited[idx]) {
        y--;
        idx -= width;
      }
      y++;
      idx += width;

      let reachLeft  = false;
      let reachRight = false;

      // Scan downward and mark
      while (y < height && canFill(idx) && !visited[idx]) {
        visited[idx] = 1;

        const p = idx * 4;
        maskData[p]   = fr;
        maskData[p+1] = fg;
        maskData[p+2] = fb;
        maskData[p+3] = 255;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // Check left neighbour
        if (x > 0) {
          if (canFill(idx - 1) && !visited[idx - 1]) {
            if (!reachLeft) { stack[head++] = x - 1; stack[head++] = y; reachLeft = true; }
          } else { reachLeft = false; }
        }

        // Check right neighbour
        if (x < width - 1) {
          if (canFill(idx + 1) && !visited[idx + 1]) {
            if (!reachRight) { stack[head++] = x + 1; stack[head++] = y; reachRight = true; }
          } else { reachRight = false; }
        }

        y++;
        idx += width;
      }
    }

    if (minX > maxX) return null; // nothing filled

    const finalImg = new ImageData(maskData, width, height);
    let canvas   = document.createElement('canvas');
    canvas.width   = width;
    canvas.height  = height;
    canvas.getContext('2d').putImageData(finalImg, 0, 0);

    if (expansion > 0) {
      canvas = FloodFill._dilateCanvas(canvas, expansion);
    }

    return canvas;
  }

  static _dilateCanvas(canvas, expansion) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    
    // Create a copy of the alpha channel to read from
    const alphaCopy = new Uint8Array(w * h);
    for (let i = 0, j = 3; i < alphaCopy.length; i++, j += 4) {
      alphaCopy[i] = data[j];
    }
    
    const outData = new Uint8ClampedArray(data.length);
    // Copy original data
    outData.set(data);

    // Array-based dilation (optimized Euclidean)
    const radius = Math.ceil(expansion);
    const rSq = radius * radius;
    
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        
        // If it's already filled, skip
        if (alphaCopy[y * w + x] > 0) continue;
        
        // Search in radius
        let found = false;
        const startY = Math.max(0, y - radius);
        const endY = Math.min(h - 1, y + radius);
        const startX = Math.max(0, x - radius);
        const endX = Math.min(w - 1, x + radius);
        
        for (let sy = startY; sy <= endY && !found; sy++) {
          for (let sx = startX; sx <= endX && !found; sx++) {
            if (alphaCopy[sy * w + sx] > 12) {
              const dx = x - sx;
              const dy = y - sy;
              if (dx * dx + dy * dy <= rSq) {
                // Find color from the source pixel that caused the dilation
                const srcIdx = (sy * w + sx) * 4;
                outData[idx] = data[srcIdx];         // R
                outData[idx + 1] = data[srcIdx + 1]; // G
                outData[idx + 2] = data[srcIdx + 2]; // B
                outData[idx + 3] = 255;              // Force solid Alpha
                found = true;
              }
            }
          }
        }
      }
    }
    
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w; outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');
    outCtx.putImageData(new ImageData(outData, w, h), 0, 0);
    return outCanvas;
  }

  // ──────────────────────────────────────────────────────
  //  Fast O(n) dilated stroke map using prefix sums
  //  (horizontal pass) + sliding-window (vertical pass)
  // ──────────────────────────────────────────────────────

  /**
   * Returns a Uint8Array where 1 = pixel is within `radius` of any stroke pixel.
   * Stroke pixels = any non-white, non-transparent pixel.
   * Complexity: O(width × height)
   */
  static _buildDilatedBlockMap(data32, width, height, radius) {
    const n = width * height;

    // ── Step 1: detect raw stroke pixels ──
    const isStroke = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const px = data32[i];
      const a  = (px >> 24) & 0xFF;
      const r  = px         & 0xFF;
      const g  = (px >>  8) & 0xFF;
      const b  = (px >> 16) & 0xFF;
      
      // IMPROVED: A pixel is a "stroke" (blocking wall) ONLY if it's sufficiently dark and opaque.
      // This prevents light anti-aliasing from creating premature walls.
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      if (a > 60 && brightness < 220) {
        isStroke[i] = 1;
      }
    }

    if (radius === 0) return isStroke;

    // ── Step 2: horizontal dilation via prefix sums ──
    // For each pixel (row, col): mark if any stroke pixel is within `radius` on the same row.
    const hDilated = new Uint8Array(n);
    const rowPrefix = new Int32Array(width + 1);

    for (let row = 0; row < height; row++) {
      const base = row * width;

      // Build prefix sum for this row
      rowPrefix[0] = 0;
      for (let x = 0; x < width; x++) {
        rowPrefix[x + 1] = rowPrefix[x] + isStroke[base + x];
      }

      // Query: any stroke in [x-r, x+r]?
      for (let x = 0; x < width; x++) {
        const lo = Math.max(0,     x - radius);
        const hi = Math.min(width, x + radius + 1);
        if (rowPrefix[hi] - rowPrefix[lo] > 0) {
          hDilated[base + x] = 1;
        }
      }
    }

    // ── Step 3: vertical dilation via sliding-window sum ──
    // For each pixel (row, col): mark if any hDilated pixel is within `radius` on the same column.
    const dilated  = new Uint8Array(n);
    const colSums  = new Int32Array(width);

    // Prime the window: sum rows [0 .. radius]
    const initEnd = Math.min(radius, height - 1);
    for (let y = 0; y <= initEnd; y++) {
      const base = y * width;
      for (let x = 0; x < width; x++) {
        colSums[x] += hDilated[base + x];
      }
    }

    for (let y = 0; y < height; y++) {
      const base = y * width;

      // Write dilated row
      for (let x = 0; x < width; x++) {
        if (colSums[x] > 0) dilated[base + x] = 1;
      }

      // Slide window: remove row that falls off the top
      const removeY = y - radius;
      if (removeY >= 0) {
        const rb = removeY * width;
        for (let x = 0; x < width; x++) colSums[x] -= hDilated[rb + x];
      }

      // Slide window: add the new row entering at the bottom
      const addY = y + radius + 1;
      if (addY < height) {
        const ab = addY * width;
        for (let x = 0; x < width; x++) colSums[x] += hDilated[ab + x];
      }
    }

    return dilated;
  }
}
