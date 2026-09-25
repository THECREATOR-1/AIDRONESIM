/**
 * AERIS Ground Control Station (GCS) - Mission Control Application Logic
 * Integrates real-time telemetry, synthetic aerial camera feed (RGB / Thermal FLIR),
 * interactive tactical map waypoint planning, MAVLink packet inspection, audio annunciator,
 * payload drop operations, and mission flight logging.
 */

// ==========================================
// 1. AUDIO SYNTHESIZER (Web Audio API)
// ==========================================
class TacticalAudio {
  private ctx: AudioContext | null = null;
  public enabled: boolean = false;

  private initCtx() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.initCtx();
      this.beep(880, 0.08, 'sine');
    }
    return this.enabled;
  }

  public click() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.04, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.04);
    } catch {
      // AudioContext blocked or not allowed yet
    }
  }

  public alertBeep() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // High alert two-tone sequence
      [0, 0.12].forEach((offset, idx) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(idx === 0 ? 950 : 1250, now + offset);
        gain.gain.setValueAtTime(0.08, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.1);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.1);
      });
    } catch {
      // ignore
    }
  }

  public warningTone() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(320, now + 0.25);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } catch {
      // ignore
    }
  }

  public payloadReleaseSound() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.4);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch {
      // ignore
    }
  }

  private beep(freq: number, duration: number, type: OscillatorType = 'sine') {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.05, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch {
      // ignore
    }
  }
}

const audio = new TacticalAudio();

// ==========================================
// 2. SYNTHETIC CAMERA FEED (RGB & THERMAL FLIR)
// ==========================================
class DroneCameraFeed {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number = 0;
  private currentMode: 'rgb' | 'thermal' = 'rgb';
  private zoomLevel: number = 1.0;
  private trackingTarget: { x: number; y: number; active: boolean; label: string; conf: number; temp: number } | null = null;
  private frameCount: number = 0;

  constructor(wrapEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'camVideoCanvas';
    this.canvas.width = 640;
    this.canvas.height = 360;
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.objectFit = 'cover';
    this.canvas.style.zIndex = '0';
    this.canvas.style.pointerEvents = 'none';

    // Insert behind overlay
    wrapEl.insertBefore(this.canvas, wrapEl.firstChild);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    this.startRendering();
  }

  public setMode(mode: 'rgb' | 'thermal') {
    this.currentMode = mode;
  }

  public setZoom(zoom: number) {
    this.zoomLevel = zoom;
  }

  public triggerTarget(x: number, y: number, label: string = 'SURVIVOR', conf: number = 91) {
    this.trackingTarget = {
      x,
      y,
      active: true,
      label,
      conf,
      temp: Math.round((36.8 + Math.random() * 0.8) * 10) / 10,
    };
    setTimeout(() => {
      if (this.trackingTarget) {
        this.trackingTarget.active = false;
      }
    }, 4500);
  }

  private startRendering() {
    const render = () => {
      this.frameCount++;
      this.draw();
      this.animId = requestAnimationFrame(render);
    };
    this.animId = requestAnimationFrame(render);
  }

  public stop() {
    cancelAnimationFrame(this.animId);
  }

  private draw() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    const t = this.frameCount * 0.02;

    ctx.save();

    // Digital Zoom transform
    if (this.zoomLevel > 1.0) {
      ctx.translate(w / 2, h / 2);
      ctx.scale(this.zoomLevel, this.zoomLevel);
      ctx.translate(-w / 2, -h / 2);
    }

    if (this.currentMode === 'rgb') {
      // RGB Aerial Terrain Simulation
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#151c14');
      grad.addColorStop(0.5, '#192218');
      grad.addColorStop(1, '#131812');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Terrain contour patches & roads
      ctx.strokeStyle = '#222d20';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        const yOff = (i * 70 + (t * 22) % 70) - 40;
        ctx.beginPath();
        ctx.moveTo(0, yOff + Math.sin(t + i) * 15);
        ctx.bezierCurveTo(w * 0.3, yOff + 30, w * 0.7, yOff - 20, w, yOff + 10);
        ctx.stroke();
      }

      // Dirt road / track scrolling diagonally
      ctx.strokeStyle = '#2d2e24';
      ctx.lineWidth = 14;
      const roadShift = (t * 30) % 200;
      ctx.beginPath();
      ctx.moveTo(-50, 400 - roadShift);
      ctx.lineTo(w + 50, 100 - roadShift);
      ctx.stroke();

      // Road dash line
      ctx.strokeStyle = '#3e3f32';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Clusters of trees / foliage
      ctx.fillStyle = '#0f170e';
      const treeOffsets = [
        { x: 120, y: 80 }, { x: 160, y: 110 }, { x: 420, y: 240 },
        { x: 470, y: 220 }, { x: 280, y: 190 }, { x: 540, y: 90 }
      ];
      treeOffsets.forEach((pt, idx) => {
        const py = (pt.y + (t * 24)) % (h + 60) - 30;
        ctx.beginPath();
        ctx.arc(pt.x + Math.sin(idx) * 10, py, 14 + (idx % 4) * 3, 0, Math.PI * 2);
        ctx.fill();
      });

    } else {
      // FLIR Thermal Infrared Mode (Ironbow / White-Hot Palette)
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#0c0714');
      grad.addColorStop(0.4, '#1b0d26');
      grad.addColorStop(1, '#0e0817');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Thermal contour lines (isotherms)
      ctx.strokeStyle = '#2c153f';
      ctx.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const yOff = (i * 60 + (t * 18) % 60) - 30;
        ctx.beginPath();
        ctx.moveTo(0, yOff + Math.cos(t * 0.5 + i) * 12);
        ctx.bezierCurveTo(w * 0.4, yOff + 25, w * 0.6, yOff - 15, w, yOff + 8);
        ctx.stroke();
      }

      // Cool terrain patches
      ctx.fillStyle = '#160924';
      ctx.beginPath();
      ctx.arc(200, 150, 45, 0, Math.PI * 2);
      ctx.fill();

      // Warm ground vehicle or heat trace
      const vY = (280 + (t * 25)) % (h + 80) - 40;
      const vGrad = ctx.createRadialGradient(380, vY, 2, 380, vY, 24);
      vGrad.addColorStop(0, '#ff9900');
      vGrad.addColorStop(0.4, '#b11212');
      vGrad.addColorStop(1, 'rgba(80,10,30,0)');
      ctx.fillStyle = vGrad;
      ctx.beginPath();
      ctx.arc(380, vY, 24, 0, Math.PI * 2);
      ctx.fill();

      // Thermal scale bar on right edge
      const barH = 140;
      const barX = w - 16;
      const barY = 90;
      const barGrad = ctx.createLinearGradient(0, barY, 0, barY + barH);
      barGrad.addColorStop(0, '#ffffff'); // > 40°C
      barGrad.addColorStop(0.2, '#ffcc00');
      barGrad.addColorStop(0.5, '#e63946');
      barGrad.addColorStop(0.8, '#4a0e4e');
      barGrad.addColorStop(1, '#07000d'); // < 10°C
      ctx.fillStyle = barGrad;
      ctx.fillRect(barX, barY, 4, barH);
      ctx.fillStyle = '#a3a3a3';
      ctx.font = '7px monospace';
      ctx.fillText('42°C', barX - 22, barY + 6);
      ctx.fillText('12°C', barX - 22, barY + barH);
    }

    // Active AI Target Tracking in Camera Feed
    if (this.trackingTarget && this.trackingTarget.active) {
      const tx = this.trackingTarget.x;
      const ty = this.trackingTarget.y;

      // In thermal mode, paint bright heat source for the human body
      if (this.currentMode === 'thermal') {
        const heatGrad = ctx.createRadialGradient(tx, ty, 3, tx, ty, 26);
        heatGrad.addColorStop(0, '#ffffff');
        heatGrad.addColorStop(0.25, '#ffe600');
        heatGrad.addColorStop(0.6, '#d61f1f');
        heatGrad.addColorStop(1, 'rgba(214,31,31,0)');
        ctx.fillStyle = heatGrad;
        ctx.beginPath();
        ctx.arc(tx, ty, 26, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Human silhouette in RGB
        ctx.fillStyle = '#dcd7c9';
        ctx.beginPath();
        ctx.arc(tx, ty - 6, 4, 0, Math.PI * 2); // head
        ctx.fill();
        ctx.fillRect(tx - 3, ty - 2, 6, 12); // body
      }

      // Animated Corner Brackets Reticle
      ctx.strokeStyle = '#D61F1F';
      ctx.lineWidth = 2;
      const bw = 54;
      const bh = 54;
      const bx = tx - bw / 2;
      const by = ty - bh / 2;
      const cLen = 12;

      // Top-Left
      ctx.beginPath();
      ctx.moveTo(bx, by + cLen);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + cLen, by);
      ctx.stroke();

      // Top-Right
      ctx.beginPath();
      ctx.moveTo(bx + bw - cLen, by);
      ctx.lineTo(bx + bw, by);
      ctx.lineTo(bx + bw, by + cLen);
      ctx.stroke();

      // Bottom-Left
      ctx.beginPath();
      ctx.moveTo(bx, by + bh - cLen);
      ctx.lineTo(bx, by + bh);
      ctx.lineTo(bx + cLen, by + bh);
      ctx.stroke();

      // Bottom-Right
      ctx.beginPath();
      ctx.moveTo(bx + bw - cLen, by + bh);
      ctx.lineTo(bx + bw, by + bh);
      ctx.lineTo(bx + bw, by + bh - cLen);
      ctx.stroke();

      // Target Metadata Tag
      ctx.fillStyle = '#D61F1F';
      ctx.fillRect(bx, by - 16, 114, 15);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8.5px JetBrains Mono, monospace';
      const tagText = `${this.trackingTarget.label} ${this.trackingTarget.conf}% [${this.trackingTarget.temp}°C]`;
      ctx.fillText(tagText, bx + 4, by - 5);
    }

    // Optical Gimbal Reticle & Crosshairs in Center
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    const cx = w / 2;
    const cy = h / 2;

    ctx.beginPath();
    // Center cross
    ctx.moveTo(cx - 24, cy); ctx.lineTo(cx - 6, cy);
    ctx.moveTo(cx + 6, cy); ctx.lineTo(cx + 24, cy);
    ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy - 6);
    ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 24);
    ctx.stroke();

    // Center circular reticle
    ctx.beginPath();
    ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    ctx.stroke();

    // Scan lines / CRT raster effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (let i = 0; i < h; i += 3) {
      ctx.fillRect(0, i, w, 1);
    }

    // Telemetry text overlay on canvas
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText(`ZOOM: ${this.zoomLevel.toFixed(1)}X`, 14, h - 28);
    ctx.fillText(`FOV: ${(58 / this.zoomLevel).toFixed(1)}°`, 14, h - 16);
    ctx.fillText(`GIMBAL: 0° PITCH -45°`, w - 140, h - 28);
    ctx.fillText(`FPS: 30.0`, w - 140, h - 16);

    ctx.restore();
  }
}

// ==========================================
// 3. MAVLINK PACKET SIMULATOR & INSPECTOR
// ==========================================
interface MavlinkMsg {
  ts: string;
  sysId: number;
  compId: number;
  msgId: number;
  name: string;
  payload: Record<string, string | number>;
}

class MavlinkEngine {
  private packets: MavlinkMsg[] = [];
  private seq: number = 0;
  private onPacketCallback?: (p: MavlinkMsg) => void;
  private intervalId: number = 0;

  constructor() {
    this.startStreaming();
  }

  public onPacket(cb: (p: MavlinkMsg) => void) {
    this.onPacketCallback = cb;
  }

  private startStreaming() {
    const msgDefs = [
      () => ({
        msgId: 0,
        name: 'HEARTBEAT',
        payload: { type: 'QUADROTOR', autopilot: 'ARDUPILOT', base_mode: 209, custom_mode: 4, system_status: 'ACTIVE' }
      }),
      () => ({
        msgId: 33,
        name: 'GLOBAL_POSITION_INT',
        payload: {
          lat: -353632610 + Math.floor(Math.random() * 200),
          lon: 1491652300 + Math.floor(Math.random() * 200),
          alt: 18400 + Math.floor(Math.random() * 500),
          relative_alt: 18400,
          vx: 480,
          vy: 120,
          vz: -80,
          hdg: 12700
        }
      }),
      () => ({
        msgId: 30,
        name: 'ATTITUDE',
        payload: {
          roll: (0.036 + (Math.random() - 0.5) * 0.02).toFixed(4),
          pitch: (-0.024 + (Math.random() - 0.5) * 0.02).toFixed(4),
          yaw: 2.216,
          rollspeed: 0.002,
          pitchspeed: -0.001,
          yawspeed: 0.015
        }
      }),
      () => ({
        msgId: 1,
        name: 'SYS_STATUS',
        payload: { onboard_control_sensors_present: 35651599, drop_rate_comm: 0, errors_comm: 0, battery_voltage: 15720, battery_current: 1420 }
      }),
      () => ({
        msgId: 74,
        name: 'VFR_HUD',
        payload: { airspeed: 4.8, groundspeed: 4.8, heading: 127, throttle: 58, alt: 18.4, climb: 0.8 }
      })
    ];

    this.intervalId = window.setInterval(() => {
      this.seq++;
      const pick = msgDefs[this.seq % msgDefs.length]();
      const now = new Date();
      const ts = [now.getHours(), now.getMinutes(), now.getSeconds(), Math.floor(now.getMilliseconds() / 100)]
        .map((n, i) => (i < 3 ? String(n).padStart(2, '0') : String(n)))
        .join(':');

      const packet: MavlinkMsg = {
        ts,
        sysId: 1,
        compId: 1,
        msgId: pick.msgId,
        name: pick.name,
        payload: pick.payload
      };

      this.packets.unshift(packet);
      if (this.packets.length > 50) this.packets.pop();

      if (this.onPacketCallback) {
        this.onPacketCallback(packet);
      }
    }, 280);
  }

  public getRecentPackets(): MavlinkMsg[] {
    return this.packets;
  }

  public stop() {
    clearInterval(this.intervalId);
  }
}

const mavlink = new MavlinkEngine();

// ==========================================
// 4. MAP INTERACTION & MISSION PLANNER
// ==========================================
function setupInteractiveMap(cameraFeed: DroneCameraFeed) {
  const mapCanvas = document.getElementById('mapCanvas') as HTMLCanvasElement | null;
  if (!mapCanvas) return;

  // Add click to dispatch or create custom waypoint
  mapCanvas.style.cursor = 'crosshair';

  let isDragging = false;
  let lastX = 0;
  let lastY = 0;

  mapCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  mapCanvas.addEventListener('mousemove', (e) => {
    const rect = mapCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Optional coordinate tooltip update
    const latEst = (-35.363261 - y * 0.00003).toFixed(6);
    const lonEst = (149.165230 + x * 0.00003).toFixed(6);

    const modeTag = document.getElementById('mapMode');
    if (modeTag && !isDragging) {
      modeTag.setAttribute('title', `Pointer Lat/Lon: ${latEst}, ${lonEst}`);
    }
  });

  // Click on map to drop target / trigger survivor or waypoint
  mapCanvas.addEventListener('click', (e) => {
    const rect = mapCanvas.getBoundingClientRect();
    const clickX = ((e.clientX - rect.left) / rect.width) * mapCanvas.width;
    const clickY = ((e.clientY - rect.top) / rect.height) * mapCanvas.height;

    audio.click();

    // Check if user clicked inside search area
    if (clickX >= 150 && clickX <= 800 && clickY >= 60 && clickY <= 310) {
      // Trigger AI target on camera feed around this point
      cameraFeed.triggerTarget(260 + (Math.random() - 0.5) * 80, 160 + (Math.random() - 0.5) * 60, 'HUMAN_POI', 89);
      if (typeof (window as unknown as { toast?: (t: string, m: string) => void }).toast === 'function') {
        (window as unknown as { toast: (t: string, m: string) => void }).toast('POI MARKED', `Waypoint commanded at (${Math.round(clickX)}, ${Math.round(clickY)})`);
      }
    }
  });

  // Wheel to zoom map
  mapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    if (typeof (window as unknown as { mapZoom?: (d: number) => void }).mapZoom === 'function') {
      (window as unknown as { mapZoom: (d: number) => void }).mapZoom(dir);
    }
  }, { passive: false });
}

// ==========================================
// 5. RESCUE PAYLOAD DEPLOYMENT OPERATION
// ==========================================
function deployRescuePayload(cameraFeed: DroneCameraFeed) {
  audio.payloadReleaseSound();
  audio.alertBeep();

  const lat = document.getElementById('ovLat')?.textContent || '-35.363261';
  const lon = document.getElementById('ovLon')?.textContent || '149.165230';
  const alt = document.getElementById('ovAlt')?.textContent || '18.4 m';

  // Trigger camera visual beacon
  cameraFeed.triggerTarget(320, 180, 'PAYLOAD_DROPPED', 99);

  if (typeof (window as unknown as { addLog?: (t: string, m: string) => void }).addLog === 'function') {
    (window as unknown as { addLog: (t: string, m: string) => void }).addLog('ALERT', `Emergency supply kit released at ${lat}, ${lon} (Alt: ${alt})`);
    (window as unknown as { addLog: (t: string, m: string) => void }).addLog('SUCCESS', 'Parachute canopy deployed — descent nominal');
  }

  if (typeof (window as unknown as { toast?: (t: string, m: string) => void }).toast === 'function') {
    (window as unknown as { toast: (t: string, m: string) => void }).toast('PAYLOAD DEPLOYED', `Medical supply drop confirmed at Alt: ${alt}`);
  }
}

// ==========================================
// 6. EXPORT MISSION LOGS (JSON / CSV)
// ==========================================
function exportMissionLogs() {
  audio.click();
  const logRows = document.querySelectorAll('#logWrap .logrow');
  const logs: Array<{ time: string; tag: string; message: string }> = [];

  logRows.forEach((row) => {
    const time = row.querySelector('.t')?.textContent || '';
    const tag = row.querySelector('.tag')?.textContent || '';
    const message = row.querySelector('.msg')?.textContent || '';
    logs.push({ time, tag, message });
  });

  const missionSummary = {
    uav: 'AERIS-UAV-01',
    mission: 'SEARCH & RESCUE',
    exportTime: new Date().toISOString(),
    status: document.getElementById('missionStateText')?.textContent || 'AUTONOMOUS SEARCH',
    telemetry: {
      lat: document.getElementById('ovLat')?.textContent,
      lon: document.getElementById('ovLon')?.textContent,
      altitude: document.getElementById('tAlt')?.textContent,
      battery: document.getElementById('tBat')?.textContent,
      speed: document.getElementById('tSpd')?.textContent,
      heading: document.getElementById('tHdg')?.textContent,
      voltage: document.getElementById('tVolt')?.textContent,
    },
    aiDetections: {
      objects: document.getElementById('aiObjects')?.textContent,
      survivors: document.getElementById('aiSurvivors')?.textContent,
      lastDetection: document.getElementById('aiLast')?.textContent,
    },
    mavlinkPackets: mavlink.getRecentPackets().slice(0, 15),
    eventLogs: logs
  };

  const blob = new Blob([JSON.stringify(missionSummary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AERIS_SAR_MISSION_LOG_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  if (typeof (window as unknown as { toast?: (t: string, m: string) => void }).toast === 'function') {
    (window as unknown as { toast: (t: string, m: string) => void }).toast('MISSION LOG EXPORTED', 'Flight telemetries and detection records downloaded');
  }
}

// ==========================================
// 7. UI ENHANCEMENTS & EXTENSIONS
// ==========================================
function mountExtendedControls(cameraFeed: DroneCameraFeed) {
  // 1. Add Audio toggle button to header
  const headerRight = document.querySelector('#header .right');
  if (headerRight) {
    const audioBtn = document.createElement('button');
    audioBtn.className = 'icon-btn';
    audioBtn.id = 'tacticalAudioToggle';
    audioBtn.title = 'Toggle Mission Control Tactical Audio';
    audioBtn.innerHTML = '🔊 AUDIO: OFF';
    audioBtn.style.color = 'var(--text3)';
    audioBtn.style.display = 'flex';
    audioBtn.style.alignItems = 'center';
    audioBtn.style.gap = '5px';

    audioBtn.onclick = () => {
      const active = audio.toggle();
      audioBtn.innerHTML = active ? '🔊 AUDIO: ON' : '🔈 AUDIO: OFF';
      audioBtn.style.color = active ? 'var(--green)' : 'var(--text3)';
      audioBtn.style.borderColor = active ? 'var(--green)' : 'var(--border)';
    };

    headerRight.insertBefore(audioBtn, headerRight.firstChild);
  }

  // 2. Add Camera Digital Zoom buttons & Snapshot
  const camTabs = document.querySelector('.cam-tabs');
  if (camTabs) {
    const zoomWrap = document.createElement('div');
    zoomWrap.style.marginLeft = 'auto';
    zoomWrap.style.display = 'flex';
    zoomWrap.style.gap = '4px';

    const z1 = document.createElement('button');
    z1.className = 'icon-btn';
    z1.textContent = '1X';
    z1.onclick = () => {
      audio.click();
      cameraFeed.setZoom(1.0);
      z1.style.color = '#fff';
      z2.style.color = 'var(--text2)';
      z4.style.color = 'var(--text2)';
    };

    const z2 = document.createElement('button');
    z2.className = 'icon-btn';
    z2.textContent = '2X';
    z2.onclick = () => {
      audio.click();
      cameraFeed.setZoom(2.0);
      z2.style.color = '#fff';
      z1.style.color = 'var(--text2)';
      z4.style.color = 'var(--text2)';
    };

    const z4 = document.createElement('button');
    z4.className = 'icon-btn';
    z4.textContent = '4X';
    z4.onclick = () => {
      audio.click();
      cameraFeed.setZoom(4.0);
      z4.style.color = '#fff';
      z1.style.color = 'var(--text2)';
      z2.style.color = 'var(--text2)';
    };

    const snapBtn = document.createElement('button');
    snapBtn.className = 'icon-btn';
    snapBtn.innerHTML = '📷 SNAPSHOT';
    snapBtn.onclick = () => {
      audio.click();
      if (typeof (window as unknown as { toast?: (t: string, m: string) => void }).toast === 'function') {
        (window as unknown as { toast: (t: string, m: string) => void }).toast('RECON SNAPSHOT', 'Optical frame captured with GPS geostamp');
      }
      if (typeof (window as unknown as { addLog?: (t: string, m: string) => void }).addLog === 'function') {
        const lat = document.getElementById('ovLat')?.textContent || '-35.363261';
        const lon = document.getElementById('ovLon')?.textContent || '149.165230';
        (window as unknown as { addLog: (t: string, m: string) => void }).addLog('INFO', `High-res frame archived at ${lat}, ${lon}`);
      }
    };

    zoomWrap.appendChild(z1);
    zoomWrap.appendChild(z2);
    zoomWrap.appendChild(z4);
    zoomWrap.appendChild(snapBtn);
    camTabs.appendChild(zoomWrap);
  }

  // 3. Connect Camera Mode Switch buttons to Camera Canvas
  const tabRGB = document.getElementById('camTabRGB');
  const tabTh = document.getElementById('camTabTh');

  if (tabRGB) {
    const origRGBClick = tabRGB.onclick;
    tabRGB.onclick = (e) => {
      audio.click();
      cameraFeed.setMode('rgb');
      if (typeof origRGBClick === 'function') origRGBClick.call(tabRGB, e);
    };
  }

  if (tabTh) {
    const origThClick = tabTh.onclick;
    tabTh.onclick = (e) => {
      audio.click();
      cameraFeed.setMode('thermal');
      if (typeof origThClick === 'function') origThClick.call(tabTh, e);
    };
  }

  // 4. Add "Deploy Payload" and "Export Logs" to Demo Controls Grid
  const ctlGrid = document.querySelector('#settingsPanel .ctl-grid');
  if (ctlGrid) {
    // Rescue Payload Drop Button
    const payloadBtn = document.createElement('button');
    payloadBtn.className = 'btn';
    payloadBtn.style.background = '#8B0000';
    payloadBtn.innerHTML = '📦 DEPLOY RESCUE PAYLOAD';
    payloadBtn.onclick = () => deployRescuePayload(cameraFeed);

    // Export Mission Log Button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn secondary';
    exportBtn.innerHTML = '📥 EXPORT MISSION LOG';
    exportBtn.onclick = exportMissionLogs;

    // Insert payload before export or controls
    ctlGrid.insertBefore(payloadBtn, ctlGrid.firstChild);
    ctlGrid.appendChild(exportBtn);
  }

  // 5. Add MAVLink Stream Inspector Tab in Log Card
  const logCard = document.getElementById('logCard');
  if (logCard) {
    const headerTitle = logCard.querySelector('.panel-title');
    if (headerTitle) {
      const tabWrap = document.createElement('div');
      tabWrap.style.display = 'flex';
      tabWrap.style.gap = '6px';

      const logTabBtn = document.createElement('button');
      logTabBtn.className = 'icon-btn';
      logTabBtn.textContent = 'EVENT LOG';
      logTabBtn.style.color = '#fff';
      logTabBtn.style.borderColor = 'var(--red-mission)';

      const mavTabBtn = document.createElement('button');
      mavTabBtn.className = 'icon-btn';
      mavTabBtn.textContent = 'MAVLINK STREAM (50Hz)';

      tabWrap.appendChild(logTabBtn);
      tabWrap.appendChild(mavTabBtn);
      headerTitle.appendChild(tabWrap);

      // Create MAVLink Stream container
      const mavWrap = document.createElement('div');
      mavWrap.id = 'mavWrap';
      mavWrap.className = 'logwrap';
      mavWrap.style.display = 'none';
      mavWrap.style.maxHeight = '230px';
      mavWrap.style.overflowY = 'auto';
      mavWrap.style.fontFamily = 'var(--mono)';
      mavWrap.style.fontSize = '10px';

      const logWrap = document.getElementById('logWrap');
      if (logWrap && logWrap.parentNode) {
        logWrap.parentNode.insertBefore(mavWrap, logWrap.nextSibling);
      }

      logTabBtn.onclick = () => {
        audio.click();
        logTabBtn.style.color = '#fff';
        logTabBtn.style.borderColor = 'var(--red-mission)';
        mavTabBtn.style.color = 'var(--text2)';
        mavTabBtn.style.borderColor = 'var(--border)';
        if (logWrap) logWrap.style.display = 'block';
        mavWrap.style.display = 'none';
      };

      mavTabBtn.onclick = () => {
        audio.click();
        mavTabBtn.style.color = '#fff';
        mavTabBtn.style.borderColor = 'var(--red-mission)';
        logTabBtn.style.color = 'var(--text2)';
        logTabBtn.style.borderColor = 'var(--border)';
        if (logWrap) logWrap.style.display = 'none';
        mavWrap.style.display = 'block';
      };

      // Populate MAVLink messages
      mavlink.onPacket((p) => {
        if (mavWrap.style.display === 'none') return;
        const row = document.createElement('div');
        row.className = 'logrow INFO';
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.padding = '4px 0';
        row.style.borderBottom = '1px solid var(--border-soft)';

        const payloadStr = Object.entries(p.payload)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ');

        row.innerHTML = `<span class="t" style="color:var(--text3);width:60px;">${p.ts}</span>
          <span class="tag" style="color:var(--green);width:150px;">${p.name} [ID:${p.msgId}]</span>
          <span class="msg" style="color:var(--text2);">${payloadStr}</span>`;

        mavWrap.prepend(row);
        while (mavWrap.children.length > 35) {
          mavWrap.removeChild(mavWrap.lastChild!);
        }
      });
    }
  }

  // 6. Hook into existing simulation survivor and alert triggers for audio feedback
  const win = window as unknown as {
    sim?: {
      simSurvivor?: () => void;
      simAlert?: () => void;
      returnHome?: () => void;
      toggleRun?: () => void;
      reset?: () => void;
    };
  };

  if (win.sim) {
    const origSimSurvivor = win.sim.simSurvivor;
    win.sim.simSurvivor = () => {
      audio.alertBeep();
      cameraFeed.triggerTarget(280 + (Math.random() - 0.5) * 60, 160 + (Math.random() - 0.5) * 50, 'SURVIVOR', 91);
      if (origSimSurvivor) origSimSurvivor();
    };

    const origSimAlert = win.sim.simAlert;
    win.sim.simAlert = () => {
      audio.warningTone();
      if (origSimAlert) origSimAlert();
    };

    const origReturnHome = win.sim.returnHome;
    win.sim.returnHome = () => {
      audio.warningTone();
      if (origReturnHome) origReturnHome();
    };

    const origToggleRun = win.sim.toggleRun;
    win.sim.toggleRun = () => {
      audio.click();
      if (origToggleRun) origToggleRun();
    };

    const origReset = win.sim.reset;
    win.sim.reset = () => {
      audio.click();
      if (origReset) origReset();
    };
  }

  // 7. Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Ignore input fields
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      win.sim?.toggleRun?.();
    } else if (e.key === 's' || e.key === 'S') {
      win.sim?.simSurvivor?.();
    } else if (e.key === 'a' || e.key === 'A') {
      win.sim?.simAlert?.();
    } else if (e.key === 'h' || e.key === 'H') {
      win.sim?.returnHome?.();
    } else if (e.key === 'r' || e.key === 'R') {
      win.sim?.reset?.();
    } else if (e.key === 't' || e.key === 'T' || e.key === 'c' || e.key === 'C') {
      const tabRGB = document.getElementById('camTabRGB');
      const tabTh = document.getElementById('camTabTh');
      if (tabRGB?.classList.contains('active')) {
        tabTh?.click();
      } else {
        tabRGB?.click();
      }
    } else if (e.key === 'p' || e.key === 'P') {
      deployRescuePayload(cameraFeed);
    } else if (e.key === 'm' || e.key === 'M') {
      document.getElementById('tacticalAudioToggle')?.click();
    }
  });
}

// ==========================================
// 8. BOOTSTRAP APPLICATION LOGIC
// ==========================================
function initAerisGCS() {
  const camWrap = document.getElementById('camWrap');
  if (!camWrap) {
    console.warn('[AERIS GCS] camWrap element not found yet, retrying on DOM ready.');
    return;
  }

  // Initialize Synthetic Drone Camera Feed
  const cameraFeed = new DroneCameraFeed(camWrap);

  // Setup Map Interactivity
  setupInteractiveMap(cameraFeed);

  // Mount Audio, MAVLink, and Extended GCS Controls
  mountExtendedControls(cameraFeed);

  console.info('[AERIS GCS] Mission Control application logic loaded and operational.');
}

// Initialize on DOM load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAerisGCS);
} else {
  initAerisGCS();
}
