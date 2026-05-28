/**
 * SubView — Floating, draggable reference image window
 */
export class SubView {
  constructor(container = document.body) {
    this.container = container;
    this.element = this._createUI();
    this.img = this.element.querySelector('.subview-img');
    this.fileInput = this.element.querySelector('.subview-file');
    this.isVisible = false;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.left = 100;
    this.top = 100;

    this._bindEvents();
  }

  _createUI() {
    const el = document.createElement('div');
    el.className = 'subview-window';
    el.innerHTML = `
      <div class="subview-header">
        <span class="subview-title">Reference</span>
        <div class="subview-controls">
          <input type="file" class="subview-file" accept="image/*" style="display:none">
          <button class="subview-btn open-btn" title="Open Image">📁</button>
          <button class="subview-btn close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="subview-content">
        <div class="subview-placeholder">No image loaded</div>
        <img class="subview-img" src="" style="display:none">
      </div>
      <div class="subview-resizer"></div>
    `;
    
    // Add base styles if not in global CSS (though we'll update index.css)
    Object.assign(el.style, {
      position: 'absolute',
      width: '250px',
      height: '250px',
      background: 'rgba(30, 30, 35, 0.95)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: '12px',
      boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
      zIndex: '10000',
      backdropFilter: 'blur(10px)',
      userSelect: 'none'
    });
    
    this.container.appendChild(el);
    return el;
  }

  _bindEvents() {
    const header = this.element.querySelector('.subview-header');
    const openBtn = this.element.querySelector('.open-btn');
    const closeBtn = this.element.querySelector('.close-btn');

    header.onpointerdown = (e) => {
      this.isDragging = true;
      this.startX = e.clientX - this.left;
      this.startY = e.clientY - this.top;
      this.element.setPointerCapture(e.pointerId);
    };

    header.onpointermove = (e) => {
      if (!this.isDragging) return;
      this.left = e.clientX - this.startX;
      this.top = e.clientY - this.startY;
      this.element.style.left = `${this.left}px`;
      this.element.style.top = `${this.top}px`;
    };

    header.onpointerup = () => { this.isDragging = false; };

    openBtn.onclick = () => this.fileInput.click();
    closeBtn.onclick = () => this.hide();

    this.fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (re) => {
          this.img.src = re.target.result;
          this.img.style.display = 'block';
          this.element.querySelector('.subview-placeholder').style.display = 'none';
        };
        reader.readAsDataURL(file);
      }
    };

    // Resizing
    const resizer = this.element.querySelector('.subview-resizer');
    let isResizing = false;
    resizer.onpointerdown = (e) => {
        isResizing = true;
        e.stopPropagation();
        this.element.setPointerCapture(e.pointerId);
    };
    window.addEventListener('pointermove', (e) => {
        if (!isResizing) return;
        const rect = this.element.getBoundingClientRect();
        this.element.style.width = `${e.clientX - rect.left}px`;
        this.element.style.height = `${e.clientY - rect.top}px`;
    });
    window.addEventListener('pointerup', () => isResizing = false);
  }

  show() {
    this.isVisible = true;
    this.element.style.display = 'flex';
    this.element.style.left = `${this.left}px`;
    this.element.style.top = `${this.top}px`;
  }

  hide() {
    this.isVisible = false;
    this.element.style.display = 'none';
  }

  toggle() {
    this.isVisible ? this.hide() : this.show();
  }
}
