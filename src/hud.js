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
  const isPistol = wpn?.type === 'gun' && !wpn?.autofire;
  const baseGap  = isPistol ? 10 : 5;

  // Dynamic gap: smoothed envelope (fast expand on shots/movement, slow contract).
  // When the dynamic-crosshair option is off, the gap stays fixed (classic static).
  const gap = baseGap + (dynamicCrosshair ? xhairGap : 0);
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
  document.getElementById('weapon-name').textContent = wpn.label;
  const ammoEl = document.getElementById('ammo-display');
  if (wpn.type === 'gun') {
    ammoEl.textContent = `${wpn.ammo}  /  ${wpn.reserve}`;
    ammoEl.style.display = '';
  } else {
    ammoEl.style.display = 'none';
  }
}

