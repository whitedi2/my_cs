// hud.js — crosshair + HUD.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

function drawCrosshair() {
  const canvas = document.getElementById('crosshair');
  if (canvas.style.display === 'none') return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  ctx.clearRect(0, 0, W, H);

  const wpn      = curW();
  // Snipers (AWP): no hip-fire crosshair at all — only the scope reticle (the
  // overlay's lines + red dot) when zoomed. Cleared above, so just bail.
  if (wpn?.zoomFovs) return;
  const isPistol = wpn?.type === 'gun' && !wpn?.autofire;
  const baseGap  = isPistol ? 10 : 5;

  // Firing expansion always applies (as in the original). Movement expansion
  // (running/jumping) is gated by cl_dynamiccrosshair — off = static while moving.
  const gap = baseGap + xhairGap + (dynamicCrosshair ? xhairMoveGap : 0);
  const len = 11;

  const lines = [
    [cx + gap,  cy,      cx + gap + len,  cy          ],
    [cx - gap,  cy,      cx - gap - len,  cy          ],
    [cx,        cy+gap,  cx,              cy+gap+len  ],
    [cx,        cy-gap,  cx,              cy-gap-len  ],
  ];

  ctx.lineCap = 'square';
  for (const [x1, y1, x2, y2] of lines) {
    // Dark outline for contrast on bright textures.
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    // Bright core.
    ctx.strokeStyle = 'rgba(255,243,100,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
}

// Hide the gameplay HUD (crosshair / weapon / HP / money / debug) while spectating or dead —
// a spectator has no body, so only the killfeed, round HUD and spectator banner stay. Driven
// each frame (when locked); the lock handler owns visibility while unlocked.
const _SPEC_HIDE_IDS = ['weapon-hud', 'money', 'hud'];   // crosshair handled below; player-status in updatePlayerStatus
function _updateSpectatorHudVisibility() {
  if (typeof isLocked !== 'undefined' && !isLocked) return;
  const spec = (typeof spectating !== 'undefined' && spectating) || (typeof playerDead !== 'undefined' && playerDead);
  // Crosshair stays in FIRST-PERSON spectate (we're looking through their eyes); hidden in the
  // 3rd-person spectator cams and otherwise while dead.
  const fpv = (typeof _specEye !== 'undefined' && _specEye);
  const cross = document.getElementById('crosshair');
  if (cross) { const w = (spec && !fpv) ? 'none' : 'block'; if (cross.style.display !== w) cross.style.display = w; }
  const want = spec ? 'none' : 'block';
  for (const id of _SPEC_HIDE_IDS) {
    const el = document.getElementById(id);
    if (el && el.style.display !== want) el.style.display = want;
  }
}

function updateHUD() {
  _updateSpectatorHudVisibility();
  drawCrosshair();
  const wpn = curW();
  document.getElementById('weapon-name').textContent = wpn.label + (wpn._burstMode ? '  •  BURST' : '');
  const ammoEl = document.getElementById('ammo-display');
  if (wpn.type === 'gun') {
    ammoEl.textContent = `${wpn.ammo}  /  ${wpn.reserve}`;
    ammoEl.style.display = '';
  } else if (wpn.type === 'grenade') {
    const cnt = (typeof grenadeCounts !== 'undefined') ? (grenadeCounts[wpn.id] || 0) : 1;
    ammoEl.textContent = `× ${cnt}`;
    ammoEl.style.display = '';
  } else {
    ammoEl.style.display = 'none';
  }
  updatePlayerStatus();
}

// Player HP/armor readout + the hurt vignette / death tint / death banner.
function updatePlayerStatus() {
  const ps = document.getElementById('player-status');
  if (ps) {
    const specView = (typeof spectating !== 'undefined' && spectating) || (typeof playerDead !== 'undefined' && playerDead);
    if (typeof hasJoined !== 'undefined' && hasJoined && !specView) {
      ps.style.display = 'flex';
      const hp = Math.max(0, Math.round(playerHealth));
      const hpEl = document.getElementById('ps-hp');
      hpEl.textContent = hp;
      hpEl.style.color = hp <= 25 ? '#ff5252' : '#fff';
      document.getElementById('ps-ap').textContent = Math.max(0, Math.round(playerArmor));
      document.getElementById('ps-helm').style.display = playerHelmet ? 'inline' : 'none';
    } else ps.style.display = 'none';
  }
  const hurt = document.getElementById('hurt-overlay');
  if (hurt) {
    let a = 0;
    if (typeof _hurtT !== 'undefined') {
      const age = (performance.now() - _hurtT) / 1000;
      if (age >= 0 && age < 0.5) a = 0.8 * (1 - age / 0.5);     // canon red damage flash, fades over 0.5s
    }
    hurt.style.opacity = a.toFixed(3);
  }
}

