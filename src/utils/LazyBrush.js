/**
 * LazyBrush Utility — Professional Stroke Stabilization
 * 
 * Based on the "String" or "Lazy Radius" model used in Procreate and Photoshop.
 * It provides a "virtual string" between the cursor and the actual drawing point.
 */
export class LazyBrush {
  constructor(radius = 0) {
    this.radius = radius; // "String length"
    this.x = 0;           // Current brush X
    this.y = 0;           // Current brush Y
    this.pointerX = 0;    // Last pointer X
    this.pointerY = 0;    // Last pointer Y
    this.hasMoved = false;
  }

  setRadius(r) {
    this.radius = Math.max(0, r);
  }

  reset(x, y) {
    this.x = x;
    this.y = y;
    this.pointerX = x;
    this.pointerY = y;
    this.hasMoved = false;
  }

  /**
   * Updates brush position based on pointer move.
   * Returns true if the brush actually moved.
   */
  update(pointerX, pointerY) {
    this.pointerX = pointerX;
    this.pointerY = pointerY;

    if (this.radius <= 0) {
      this.x = pointerX;
      this.y = pointerY;
      this.hasMoved = true;
      return true;
    }

    const dx = pointerX - this.x;
    const dy = pointerY - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist > this.radius) {
      // Pull the brush along the string
      const ratio = (dist - this.radius) / dist;
      this.x += dx * ratio;
      this.y += dy * ratio;
      this.hasMoved = true;
      return true;
    }

    return false;
  }

  get pos() {
    return { x: this.x, y: this.y };
  }
}
