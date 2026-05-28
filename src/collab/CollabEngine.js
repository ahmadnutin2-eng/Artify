/**
 * CollabEngine — Real-time collaboration client
 * - WebSocket connection with auto-reconnect
 * - Stroke event serialization and broadcast
 * - Presence cursors (per-user color + label)
 * - Session management (create/join)
 * - Ping/latency display
 */
export class CollabEngine {
  constructor(canvasEngine, brushEngine) {
    this.engine = canvasEngine;
    this.brush = brushEngine;
    this.ws = null;
    this.sessionCode = null;
    this.userId = this._genId();
    this.userName = 'User ' + Math.floor(Math.random() * 900 + 100);
    this.userColor = this._genColor();
    this.connected = false;
    this.users = new Map(); // userId → { name, color, cursor }

    this.onStatus = null;      // (status: 'connected'|'disconnected'|'connecting') => void
    this.onUsersChange = null; // (users) => void
    this.onStrokeReceived = null; // (strokeData) => void

    this._cursors = new Map(); // userId → DOM element
    this._pingStart = 0;
    this._pingInterval = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;

    // Determine server URL
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env?.VITE_WS_URL || 
                 ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') 
                   ? `${proto}//${location.hostname}:3001` 
                   : 'wss://artify-b08a.onrender.com');
    this.serverUrl = host;

    this._strokeQueue = [];
    this._flushInterval = null;
  }

  // ── Connection ──

  connect(code, isHost, customIp = null) {
    this.sessionCode = code;
    this._setStatus('connecting');

    if (customIp) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.serverUrl = `${proto}//${customIp.replace(/:\d+$/, '')}:3001`;
    }

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (e) {
      this._setStatus('disconnected');
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._setStatus('connected');
      this._reconnectDelay = 2000;
      this._send({ type: 'join', code, userId: this.userId, name: this.userName, color: this.userColor, isHost });
      this._startPing();
      this._startFlush();
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._handleMessage(msg);
      } catch {}
    };

    this.ws.onerror = () => {};

    this.ws.onclose = () => {
      this.connected = false;
      this._setStatus('disconnected');
      this._stopPing();
      this._stopFlush();
      // Auto-reconnect
      if (this.sessionCode) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 15000);
          this.connect(code, isHost);
        }, this._reconnectDelay);
      }
    };
  }

  disconnect() {
    this.sessionCode = null;
    clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    this._clearCursors();
    this._setStatus('disconnected');
  }

  // ── Stroke Broadcasting ──

  sendStrokeEvent(type, data) {
    if (!this.connected) return;
    this._strokeQueue.push({ type, ...data, userId: this.userId, ts: Date.now() });
  }

  sendFillEvent(x, y, color) {
    if (!this.connected) return;
    this._strokeQueue.push({ type: 'fill', x, y, color, userId: this.userId, ts: Date.now() });
  }

  _startFlush() {
    this._flushInterval = setInterval(() => {
      if (this._strokeQueue.length === 0) return;
      const batch = this._strokeQueue.splice(0);
      this._send({ type: 'strokes', batch });
    }, 16); // ~60fps flush
  }

  _stopFlush() {
    clearInterval(this._flushInterval);
  }

  sendCursor(x, y) {
    if (!this.connected) return;
    this._send({ type: 'cursor', userId: this.userId, x, y });
  }

  // ── Message Handling ──

  _handleMessage(msg) {
    switch (msg.type) {
      case 'users':
        this.users = new Map(msg.users.map(u => [u.userId, u]));
        this._syncCursors();
        if (this.onUsersChange) this.onUsersChange([...this.users.values()]);
        break;

      case 'strokes':
        if (!this.onStrokeReceived) break;
        for (const stroke of msg.batch) {
          if (stroke.userId !== this.userId) {
            this.onStrokeReceived(stroke);
          }
        }
        break;

      case 'cursor':
        if (msg.userId !== this.userId) {
          this._updateCursor(msg.userId, msg.x, msg.y);
        }
        break;

      case 'pong':
        const latency = Date.now() - this._pingStart;
        document.getElementById('collab-ping').textContent = `Latency: ${latency}ms`;
        break;

      case 'session_created':
        break;
    }
  }

  // ── Cursor UI ──

  _syncCursors() {
    const container = document.getElementById('canvas-container');
    if (!container) return;
    // Remove cursors for gone users
    for (const [uid, el] of this._cursors) {
      if (!this.users.has(uid)) { el.remove(); this._cursors.delete(uid); }
    }
    // Add new cursors
    for (const [uid, user] of this.users) {
      if (uid === this.userId) continue;
      if (!this._cursors.has(uid)) {
        const el = document.createElement('div');
        el.className = 'collab-cursor';
        el.dataset.uid = uid;
        el.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 20 20">
            <path d="M4 2l14 7-7 2-3 7z" fill="${user.color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <div class="collab-cursor-label" style="background:${user.color}">${user.name}</div>
        `;
        container.appendChild(el);
        this._cursors.set(uid, el);
      }
    }
  }

  _updateCursor(userId, x, y) {
    const el = this._cursors.get(userId);
    if (!el) return;
    // Convert canvas coords to screen coords
    const pos = this.engine.canvasToScreen(x, y);
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
  }

  _clearCursors() {
    for (const [, el] of this._cursors) el.remove();
    this._cursors.clear();
  }

  // ── Ping ──

  _startPing() {
    this._pingInterval = setInterval(() => {
      this._pingStart = Date.now();
      this._send({ type: 'ping' });
    }, 3000);
  }

  _stopPing() { clearInterval(this._pingInterval); }

  // ── Utils ──

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _setStatus(status) {
    this.status = status;
    if (this.onStatus) this.onStatus(status);
  }

  _genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  _genColor() {
    const colors = ['#4D9EFF','#A78BFA','#34D399','#FB923C','#F472B6','#60A5FA','#FBBF24'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  static generateCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }
}
