/**
 * UndoManager — Snapshot-based undo/redo
 * - Per-layer snapshots before each stroke
 * - Up to 50 history steps
 * - Efficient OffscreenCanvas storage
 */
export class UndoManager {
  constructor(engine) {
    this.engine = engine;
    this.stack = [];   // array of { layerIndex, snap, desc }
    this.future = [];  // redo stack
    
    // Dynamically calculate safe max steps based on document size
    // A 4K canvas (3840x2160) takes ~33MB per snapshot in raw pixel data.
    // We aim to keep total undo memory under ~500MB max.
    const pixels = engine.docWidth * engine.docHeight;
    const mbPerSnap = (pixels * 4) / (1024 * 1024);
    
    // Base 50 steps, but scale down for massive canvases (min 5 steps)
    this.maxSteps = Math.max(5, Math.min(50, Math.floor(500 / mbPerSnap)));
    console.log(`[UndoManager] Max steps dynamically set to: ${this.maxSteps} (Canvas ~${mbPerSnap.toFixed(1)}MB per snap)`);
  }

  // Call BEFORE making a change
  snapshot(desc = 'stroke') {
    const layer = this.engine.getActiveLayer();
    if (!layer) return;
    const snap = this.engine.snapshot();
    this.stack.push({
      layerIndex: this.engine.activeLayerIndex,
      snap,
      desc
    });
    if (this.stack.length > this.maxSteps) this.stack.shift();
    this.future = []; // invalidate redo
  }

  undo() {
    if (!this.stack.length) return false;
    // Save current as redo
    const layer = this.engine.getActiveLayer();
    if (layer) {
      this.future.push({
        layerIndex: this.engine.activeLayerIndex,
        snap: this.engine.snapshot()
      });
    }
    const state = this.stack.pop();
    this.engine.activeLayerIndex = state.layerIndex;
    this.engine.restoreSnapshot(state.snap);
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    const layer = this.engine.getActiveLayer();
    if (layer) {
      this.stack.push({
        layerIndex: this.engine.activeLayerIndex,
        snap: this.engine.snapshot()
      });
    }
    const state = this.future.pop();
    this.engine.activeLayerIndex = state.layerIndex;
    this.engine.restoreSnapshot(state.snap);
    return true;
  }

  canUndo() { return this.stack.length > 0; }
  canRedo() { return this.future.length > 0; }
  clear() { this.stack = []; this.future = []; }
}
