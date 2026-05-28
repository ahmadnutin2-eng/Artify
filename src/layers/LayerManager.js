/**
 * LayerManager — Layer stack with UI
 * - Add/delete/reorder layers
 * - Opacity, visibility, lock, alpha-lock
 * - Blend modes
 * - Thumbnail previews
 * - Drag & drop reordering
 */
export class LayerManager {
  constructor(engine, listEl) {
    this.engine = engine;
    this.listEl = listEl;
    this.onLayerChange = null;
    this._dragSrc = null;

    // Init with one default layer
    this.engine.addLayer('Background');
    this.render();
  }

  addLayer() {
    this.engine.addLayer('Layer');
    this.render();
    if (this.onLayerChange) this.onLayerChange();
  }

  deleteLayer(index) {
    this.engine.deleteLayer(index);
    this.render();
    if (this.onLayerChange) this.onLayerChange();
  }

  selectLayer(index) {
    this.engine.activeLayerIndex = index;
    // Fast path: just update the active class instead of rebuilding the DOM
    const items = this.listEl.querySelectorAll('.layer-item');
    items.forEach(item => {
      if (parseInt(item.dataset.index) === index) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    if (this.onLayerChange) this.onLayerChange();
  }

  setOpacity(index, val) {
    this.engine.layers[index].opacity = val / 100;
    this.engine.markDirty();
    // Do not update thumbnail here! Re-drawing large canvases on slider move kills performance.
  }

  toggleVisibility(index) {
    this.engine.layers[index].visible = !this.engine.layers[index].visible;
    this.engine.markDirty();
    this.render();
  }

  toggleLock(index) {
    this.engine.layers[index].locked = !this.engine.layers[index].locked;
    this.render();
  }

  toggleClipping(index) {
    this.engine.layers[index].clipping = !this.engine.layers[index].clipping;
    this.engine.markDirty();
    this.render();
  }

  setBlendMode(index, mode) {
    this.engine.layers[index].blendMode = mode;
    this.engine.markDirty();
  }

  _updateThumbnail(index) {
    const layer = this.engine.layers[index];
    const el = this.listEl.querySelector(`[data-index="${index}"] .layer-thumb canvas`);
    if (!el) return;
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(layer.canvas, 0, 0, el.width, el.height);
  }

  render() {
    this.listEl.innerHTML = '';
    // Render in reverse order (top layers first visually)
    const layers = [...this.engine.layers].reverse();

    layers.forEach((layer, revIndex) => {
      const index = this.engine.layers.length - 1 - revIndex;
      const isActive = index === this.engine.activeLayerIndex;

      const item = document.createElement('div');
      item.className = `layer-item${isActive ? ' active' : ''}${layer.clipping ? ' is-clipping' : ''}`;
      // Add visual indentation for clipping mask
      if (layer.clipping) {
        item.style.borderLeft = '4px solid var(--accent)';
        item.style.paddingLeft = '16px';
        item.title = 'Clipping Mask (clips to the layer below)';
      }
      item.dataset.index = index;
      item.draggable = true;

      // Thumbnail
      const thumb = document.createElement('div');
      thumb.className = 'layer-thumb';
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 36; thumbCanvas.height = 28;
      const tctx = thumbCanvas.getContext('2d');
      tctx.drawImage(layer.canvas, 0, 0, 36, 28);
      thumb.appendChild(thumbCanvas);

      // Name
      const name = document.createElement('div');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.contentEditable = 'true';
      name.spellcheck = false;
      name.addEventListener('blur', () => { layer.name = name.textContent; });
      name.addEventListener('click', (e) => e.stopPropagation());

      // Actions
      const actions = document.createElement('div');
      actions.className = 'layer-actions';

      // Visibility
      const vis = this._makeActionBtn(layer.visible ? visIconOn() : visIconOff(), 'Toggle visibility');
      vis.addEventListener('click', (e) => { e.stopPropagation(); this.toggleVisibility(index); });

      // Lock
      const lock = this._makeActionBtn(layer.locked ? lockIconOn() : lockIconOff(), 'Lock layer');
      lock.style.color = layer.locked ? '#FBBF24' : '';
      lock.addEventListener('click', (e) => { e.stopPropagation(); this.toggleLock(index); });

      // Delete
      const del = this._makeActionBtn(trashIcon(), 'Delete layer');
      del.addEventListener('click', (e) => { e.stopPropagation(); this.deleteLayer(index); });

      // Clipping Mask toggle
      const clipBtn = document.createElement('button');
      clipBtn.className = 'layer-action-btn';
      clipBtn.innerHTML = clipIcon();
      clipBtn.title = layer.clipping ? 'Disable Clipping Mask' : 'Enable Clipping Mask';
      clipBtn.style.color = layer.clipping ? 'var(--accent)' : '';
      clipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleClipping(index);
      });

      actions.append(clipBtn, vis, lock, del);

      // Opacity slider inline
      const opSlider = document.createElement('input');
      opSlider.type = 'range'; opSlider.min = 0; opSlider.max = 100;
      opSlider.value = Math.round(layer.opacity * 100);
      opSlider.className = 'layer-opacity-slider';
      opSlider.title = 'Layer opacity';
      opSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        this.setOpacity(index, +e.target.value);
      });

      item.append(thumb, name, opSlider, actions);

      // Select on click
      item.addEventListener('click', () => this.selectLayer(index));

      // Drag & drop
      item.addEventListener('dragstart', (e) => {
        this._dragSrc = index;
        e.dataTransfer.effectAllowed = 'move';
        item.style.opacity = '0.5';
      });
      item.addEventListener('dragend', () => { item.style.opacity = ''; });
      item.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; item.style.background = 'var(--accent-dim)'; });
      item.addEventListener('dragleave', () => { item.style.background = ''; });
      item.addEventListener('drop', (e) => {
        e.preventDefault(); item.style.background = '';
        if (this._dragSrc !== null && this._dragSrc !== index) {
          this.engine.moveLayer(this._dragSrc, index);
          this.engine.activeLayerIndex = index;
          this.render();
        }
        this._dragSrc = null;
      });

      this.listEl.appendChild(item);
    });
  }

  _makeActionBtn(svgHtml, title) {
    const btn = document.createElement('button');
    btn.className = 'layer-action-btn';
    btn.innerHTML = svgHtml;
    btn.title = title;
    return btn;
  }
}

// SVG icons
const visIconOn = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const visIconOff = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const lockIconOn = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const lockIconOff = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
const trashIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
const clipIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4"/></svg>`; // Grid/clipping icon variant
