export class BrushTextures {
  static _grainCache = new Map();

  /**
   * Generates or retrieves a cached seamless noise/grain tile
   * @param {'noise'|'canvas'|'gritty'|'smooth'} type 
   * @param {number} size 
   */
  static generateGrain(type = 'noise', size = 256) {
    const cacheKey = `${type}_${size}`;
    if (this._grainCache.has(cacheKey)) return this._grainCache.get(cacheKey);

    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const d = imgData.data;

    for (let i = 0; i < d.length; i += 4) {
      let val = 255;
      if (type === 'noise') {
        val = Math.random() * 255;
      } else if (type === 'canvas') {
        const x = (i / 4) % size;
        const y = Math.floor((i / 4) / size);
        val = 200 + Math.sin(x * 0.5) * 15 + Math.cos(y * 0.5) * 15;
        val += Math.random() * 10;
      } else if (type === 'gritty') {
        val = Math.random() > 0.92 ? Math.random() * 100 : 255;
      }
      
      d[i] = d[i+1] = d[i+2] = val;
      d[i+3] = 255;
    }
    
    ctx.putImageData(imgData, 0, 0);
    this._grainCache.set(cacheKey, canvas);
    return canvas;
  }

  /**
   * Generates a brush tip shape
   * @param {'round'|'nib'|'flat'|'splatter'|'rect'} type 
   * @param {number} size 
   * @param {object} settings { hardness, angle, aspectRatio }
   */
  static generateShape(type = 'round', size = 128, settings = {}) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const { hardness = 0.8, angle = 0, aspectRatio = 1 } = settings;
    const center = size / 2;

    ctx.clearRect(0, 0, size, size);
    ctx.translate(center, center);
    ctx.rotate(angle * Math.PI / 180);
    ctx.scale(1, aspectRatio);

    if (type === 'round') {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, center);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(hardness, 'rgba(0,0,0,0.8)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, center, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'nib' || type === 'flat') {
      // Calligraphy nib (tapered rectangle)
      ctx.fillStyle = 'black';
      ctx.fillRect(-center, -center * 0.2, size, center * 0.4);
    } else if (type === 'splatter') {
      ctx.fillStyle = 'black';
      for (let i = 0; i < 15; i++) {
        const r = Math.random() * center;
        const th = Math.random() * Math.PI * 2;
        const sr = Math.random() * (size * 0.1) + 1;
        ctx.beginPath();
        ctx.arc(Math.cos(th) * r, Math.sin(th) * r, sr, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (type === 'rect') {
      ctx.fillStyle = 'black';
      ctx.fillRect(-center, -center, size, size);
    }

    return canvas;
  }
}
