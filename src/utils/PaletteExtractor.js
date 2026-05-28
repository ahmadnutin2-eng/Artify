export class PaletteExtractor {
  /**
   * Scans the canvas and returns a unique array of HEX colors.
   * Uses a downsampled version of the canvas for performance.
   * @param {CanvasEngine} engine 
   * @returns {string[]}
   */
  static extract(engine) {
    const scanSize = 128; // Small enough to be instant, large enough for most artwork
    const tempCvs = new OffscreenCanvas(scanSize, scanSize);
    const tctx = tempCvs.getContext('2d');
    
    // Draw composites into temp canvas
    tctx.scale(scanSize / engine.docWidth, scanSize / engine.docHeight);
    engine._drawLayers(tctx);
    
    const imgData = tctx.getImageData(0, 0, scanSize, scanSize).data;
    const histogram = new Map();
    
    for (let i = 0; i < imgData.length; i += 4) {
      const r = imgData[i];
      const g = imgData[i+1];
      const b = imgData[i+2];
      const a = imgData[i+3];
      
      // Ignore transparency
      if (a < 50) continue;
      
      // Ignore perfect white (background)
      if (r > 250 && g > 250 && b > 250) continue;

      // Quantization: Group similar shades to reduce noise (step of 16)
      const qr = Math.round(r / 16) * 16;
      const qg = Math.round(g / 16) * 16;
      const qb = Math.round(b / 16) * 16;
      
      const hex = `#${qr.toString(16).padStart(2,'0')}${qg.toString(16).padStart(2,'0')}${qb.toString(16).padStart(2,'0')}`.toUpperCase();
      
      histogram.set(hex, (histogram.get(hex) || 0) + 1);
    }
    
    // Convert to array and sort by frequency (dominance)
    const sortedColors = Array.from(histogram.entries())
      .sort((a, b) => b[1] - a[1]) // Most frequent first
      .map(entry => entry[0]);

    // Limit to 32 dominant colors for clarity
    return sortedColors.slice(0, 32);
  }
}
