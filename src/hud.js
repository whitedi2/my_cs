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
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,120,0.90)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
}

function updateHUD() {
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
  updateTargetHUD();
  updatePlayerStatus();
}

// Player HP/armor readout + the hurt vignette / death tint / death banner.
function updatePlayerStatus() {
  const ps = document.getElementById('player-status');
  if (ps) {
    if (typeof hasJoined !== 'undefined' && hasJoined) {
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

// Target dummy HP/armor + last-hit readout. Colors the hit text by zone and
// fades it out; bars empty as the dummy takes damage.
const _ZONE_COLOR = { 1: '#ff5252', 2: '#ffd24a', 3: '#ffb04a', 6: '#bcd' };
function updateTargetHUD() {
  const e = (typeof enemyFocus !== 'undefined') ? enemyFocus : null;
  if (!e || !e.root) return;
  const nameEl = document.getElementById('th-name');
  if (nameEl) nameEl.textContent = e.helmet ? 'Манекен (T) — кевлар + шлем' : 'Манекен (T) — кевлар';
  const hp = Math.max(0, e.health), ap = Math.max(0, e.armor);
  document.getElementById('th-hp').style.width   = (hp / ENEMY_HEALTH * 100) + '%';
  document.getElementById('th-ap').style.width   = (ap / ENEMY_ARMOR  * 100) + '%';
  document.getElementById('th-hp-n').textContent = Math.round(hp);
  document.getElementById('th-ap-n').textContent = Math.round(ap);

  const last = document.getElementById('th-last');
  if (e.lastHit) {
    const age = (performance.now() - e.lastHit.t) / 1000;
    if (age < 1.4) {
      const lbl = (typeof _HG_LABEL !== 'undefined' && _HG_LABEL[e.lastHit.hg]) || '';
      last.textContent = `−${e.lastHit.dmg}  ${lbl}`;
      last.style.color = _ZONE_COLOR[e.lastHit.hg] || '#fff';
      last.style.opacity = Math.max(0, 1 - age / 1.4);
    } else { last.textContent = ''; }
  } else { last.textContent = ''; }
}

