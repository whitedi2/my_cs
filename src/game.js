// game.js — team/class selection, money, weapon ownership, buy menu.
// Classic script, shared global scope. Loads after physics (needs gsPos / buyZones /
// playerTeam / setTeam) and weapons (WPNS / switchWeapon) and player (playerModelName);
// before input (which opens these menus and routes keys to them).

const START_MONEY = 16000;
let playerMoney = START_MONEY;
const ownedWeapons = new Set(['knife', 'usp']);   // default loadout: knife + pistol
let hasJoined = false;                            // chosen a team/class yet?

// ── Player health / armor ─────────────────────────────────────────────────────
// HP refills to 100 each round; ARMOR persists across rounds at its current value
// (CS: kevlar isn't topped up — you re-buy when it runs down). Damage sources so far:
// own HE grenade blast and the C4 explosion (no opposing team yet). The dummies don't
// shoot back. Death freezes control until the round resolves and the next one spawns you.
const PLAYER_MAX_HP = 100;
const PLAYER_MAX_AP = 100;
let playerHealth = PLAYER_MAX_HP;
let playerArmor  = 0;
let playerHelmet = false;
let playerDead   = false;
let _hurtT = -Infinity;        // wall-clock of the last damage tick (drives the red flash)

// CS armor model (ReGameDLL CBasePlayer::TakeDamage): kevlar soaks part of an armor-
// covered hit — half to health, the remainder eats armor at the bonus ratio. mp_armorratio
// 0.5 / armor bonus 0.5 are the defaults. Blasts cover the whole body (covered=true).
function _playerArmorAbsorb(dmg, covered) {
  if (playerArmor <= 0 || !covered) return dmg;
  const RATIO = 0.5, BONUS = 0.5;
  let toHealth = dmg * RATIO;
  let toArmor  = (dmg - toHealth) * BONUS;
  if (toArmor > playerArmor) { toArmor = playerArmor / BONUS; toHealth = dmg - toArmor; playerArmor = 0; }
  else playerArmor -= toArmor;
  return Math.max(0, toHealth);
}

// Apply damage to the player. opts.covered (default true) = armor can soak it.
function playerTakeDamage(dmg, opts) {
  if (playerDead || !hasJoined || dmg <= 0) return;
  opts = opts || {};
  dmg = _playerArmorAbsorb(dmg, opts.covered !== false);
  dmg = Math.max(0, Math.round(dmg));
  if (dmg <= 0) return;
  playerHealth -= dmg;
  _hurtT = performance.now();
  if (playerHealth <= 0) { playerHealth = 0; _playerDie(); }
  else if (typeof playRandom === 'function')               // original player pain grunt
    playRandom(['player/pl_fallpain1.wav', 'player/pl_fallpain2.wav', 'player/pl_fallpain3.wav'], { volume: 0.7 });
}

// Radius blast vs the player (HE / C4): linear falloff + LOS trace + armor soak —
// mirrors enemy.js enemyRadiusDamage so the player and dummies take blasts identically.
function playerRadiusDamage(origin, baseDmg, radius) {
  if (playerDead || !hasJoined || !gsPos) return;
  const cx = gsPos[0], cy = gsPos[1], cz = gsPos[2] + 36;   // ≈ center mass
  const dist = Math.hypot(cx - origin[0], cy - origin[1], cz - origin[2]);
  if (dist > radius) return;
  if (typeof traceMove === 'function') {
    const tr = traceMove([origin[0], origin[1], origin[2]], [cx, cy, cz]);
    if (tr.fraction < 0.7) return;                          // wall mostly blocks the blast
  }
  playerTakeDamage(baseDmg * (1 - dist / radius), { covered: true });
}

function _playerDie() {
  if (playerDead) return;
  playerDead = true;
  if (typeof playRandom === 'function')
    playRandom(['player/pl_fallpain1.wav', 'player/pl_fallpain2.wav', 'player/pl_fallpain3.wav'], { volume: 0.9 });
  // Sole member of your team eliminated → award the round to the other side, UNLESS a
  // live bomb is still ticking (CS keeps the round going until it blows or is defused).
  const bombLive = (typeof bomb !== 'undefined') && bomb && bomb.live;
  if (!bombLive && typeof endRound === 'function' && typeof roundPhase !== 'undefined' && roundPhase === 'live') {
    const winner = playerTeam === 't' ? 'ct' : 't';
    endRound(winner, playerTeam === 't' ? 'Вы погибли — победа Контр-террористов'
                                        : 'Вы погибли — победа Террористов');
  }
}

// HP refills, armor/helmet persist (CS). Called from rounds.js at each round start.
function resetPlayerHealth() {
  playerHealth = PLAYER_MAX_HP;
  playerDead = false;
  _hurtT = -Infinity;
}

// Grenades (slot 4) — held by count, not a single-owned slot. CS caps: HE 1, flash 2,
// smoke 1. A type with count>0 is added to ownedWeapons so slot/Q selection sees it.
const grenadeCounts = { hegrenade: 0, flashbang: 0, smokegrenade: 0 };
const GRENADE_MAX   = { hegrenade: 1, flashbang: 2, smokegrenade: 1 };

WPNS.forEach(w => { w._reserve0 = w.reserve; });  // remember full reserve for buy refills

// ── CS 1.6 buy catalog ──────────────────────────────────────────────────────
// FIXED slots, exactly like the real menu: each category is a list of numbered slots,
// and a slot holds either one item for both teams ({both}) or the team-specific
// equivalent ({ct, t}) — so the SLOT NUMBER never changes between teams and the
// muscle-memory combos match the original (e.g. Rifles→3 = M4A1 for CT / AK-47 for T,
// Rifles→4 = AWP). A slot with no item for your team renders as "—" but keeps its
// number (it doesn't get renumbered away). Prices verified vs CS 1.6 / ReGameDLL.
// `wid` = WPNS id when we have a working model (buyable); no `wid`/`equip` → shows
// the price but "нет модели" (not buyable yet).
//
// 🔹 Submenu order reconstructed from the canonical CS 1.6 buy menu (verify in-game,
//    then tweak); top-level category order matches the original exactly.
const BUY_CATALOG = [
  { name: 'Пистолеты', slots: [
    { both: { name: 'USP .45 Tactical', price: 500, wid: 'usp' } },
    { both: { name: 'Glock-18',         price: 400, wid: 'glock18' } },
    { both: { name: 'Desert Eagle',     price: 650, wid: 'deagle' } },
    { both: { name: 'P228 Compact',     price: 600, wid: 'p228' } },
    { both: { name: 'Dual Berettas',    price: 800 } },                  // Elites — both, no model yet
    { ct:   { name: 'Five-SeveN',       price: 750, wid: 'fiveseven' } }, // CT only
  ] },
  { name: 'Дробовики', slots: [
    { both: { name: 'M3 Super 90',      price: 1700 } },
    { both: { name: 'XM1014',           price: 3000 } },
  ] },
  { name: 'Пистолеты-пулемёты', slots: [
    { both: { name: 'MP5 Navy',         price: 1500, wid: 'mp5' } },
    { ct: { name: 'TMP', price: 1250, wid: 'tmp' }, t: { name: 'MAC-10', price: 1400, wid: 'mac10' } },
    { both: { name: 'UMP45',            price: 1700, wid: 'ump45' } },
    { both: { name: 'P90',              price: 2350, wid: 'p90' } },
  ] },
  { name: 'Винтовки', slots: [
    { ct: { name: 'FAMAS',           price: 2250, wid: 'famas' }, t: { name: 'Galil',           price: 2000, wid: 'galil' } },
    { both: { name: 'Steyr Scout',   price: 2750 } },
    { ct: { name: 'M4A1 Carbine',    price: 3100, wid: 'm4' },    t: { name: 'AK-47',           price: 2500, wid: 'ak47' } },
    { both: { name: 'AWP',           price: 4750, wid: 'awp' } },
    { ct: { name: 'Steyr AUG',       price: 3500, wid: 'aug' },   t: { name: 'SG-552 Commando', price: 3500, wid: 'sg552' } },
    { ct: { name: 'SG-550 Auto',     price: 4200 },               t: { name: 'G3/SG-1 Auto',    price: 5000 } },
  ] },
  { name: 'Пулемёты', slots: [
    { both: { name: 'M249 Para',        price: 5750, wid: 'm249' } },
  ] },
  { name: 'Боезапас (основной)',  ammo: 'primary'   },
  { name: 'Боезапас (пистолет)',  ammo: 'secondary' },
  { name: 'Снаряжение', slots: [
    { both: { name: 'Кевлар',                 price: 650,  equip: 'kevlar' } },
    { both: { name: 'Кевлар + Шлем',          price: 1000, equip: 'kevlarhelm' } },
    { both: { name: 'Флешка',                 price: 200,  wid: 'flashbang' } },
    { both: { name: 'Граната HE',             price: 300,  wid: 'hegrenade' } },
    { both: { name: 'Дымовая граната',        price: 300,  wid: 'smokegrenade' } },
    { ct:   { name: 'Дефуз-кит',              price: 200,  equip: 'defusekit' } },
    { both: { name: 'Прибор ночного видения', price: 1250 } },
  ] },
];

// The item in a fixed slot for the current team ({both} or the team-specific one), or
// null if the slot has nothing for this team (renders as "—" but keeps its number).
function _slotItem(slot) {
  return (slot && (slot.both || slot[playerTeam])) || null;
}

// Selectable player classes per team (only converted models with full anim sets).
const CLASSES = {
  t:  [{ name: 'Elite Crew', model: 'leet' }, { name: 'Phoenix Connexion', model: 'terror' }],
  ct: [{ name: 'GIGN',       model: 'gign' }],
};

// ── Buy zone ────────────────────────────────────────────────────────────────
function inBuyZone() {
  if (!gsPos || typeof buyZones === 'undefined') return false;
  for (const z of buyZones) {
    if (z.team !== playerTeam) continue;
    if (gsPos[0] >= z.min[0] && gsPos[0] <= z.max[0] &&
        gsPos[1] >= z.min[1] && gsPos[1] <= z.max[1] &&
        gsPos[2] >= z.min[2] - 64 && gsPos[2] <= z.max[2] + 64) return true;
  }
  return false;
}

// ── Buy ─────────────────────────────────────────────────────────────────────
let _buyMsg = '', _buyMsgT = -Infinity;
function _flashBuy(msg) { _buyMsg = msg; _buyMsgT = performance.now(); }

function buyItem(item) {
  if (typeof buyTimeOpen === 'function' && !buyTimeOpen()) return _flashBuy('Время закупки вышло');
  if (item.teams && !item.teams.includes(playerTeam)) return _flashBuy('Недоступно вашей команде');
  if (!inBuyZone())     return _flashBuy('Вы не в зоне закупки');
  // Kevlar / kevlar+helmet — set armor (and helmet). CS: re-buying full armor is blocked;
  // the +helmet item still sells you just the helmet if you already have full vest.
  if (item.equip === 'kevlar' || item.equip === 'kevlarhelm') {
    const wantHelm = item.equip === 'kevlarhelm';
    const haveFullArmor = playerArmor >= PLAYER_MAX_AP;
    if (haveFullArmor && (!wantHelm || playerHelmet)) return _flashBuy('Броня уже есть');
    if (playerMoney < item.price) return _flashBuy('Недостаточно денег');
    playerMoney -= item.price;
    playerArmor = PLAYER_MAX_AP;
    if (wantHelm) playerHelmet = true;
    if (typeof playSound === 'function') playSound('items/gunpickup2.wav', { volume: 0.8 });
    return _flashBuy(`Куплено: ${item.name}  −$${item.price}`);
  }
  // Defuse kit (CT) — sets the faster-defuse flag used by the bomb code.
  if (item.equip === 'defusekit') {
    if (typeof hasDefuseKit !== 'undefined' && hasDefuseKit) return _flashBuy('Дефуз-кит уже есть');
    if (playerMoney < item.price) return _flashBuy('Недостаточно денег');
    playerMoney -= item.price; hasDefuseKit = true;
    if (typeof playSound === 'function') playSound('items/gunpickup2.wav', { volume: 0.8 });
    return _flashBuy(`Куплено: ${item.name}  −$${item.price}`);
  }
  if (!item.wid)        return _flashBuy('Нет модели — недоступно');
  const idx = WPNS.findIndex(w => w.id === item.wid);
  if (idx < 0)          return _flashBuy('Оружие недоступно');
  const w = WPNS[idx];
  // Grenades: capped count, no slot-drop. Buying just adds one (up to the cap).
  if (w.type === 'grenade') {
    if ((grenadeCounts[w.id] || 0) >= (GRENADE_MAX[w.id] || 1))
      return _flashBuy(`Максимум ${w.label}`);
    if (playerMoney < item.price) return _flashBuy('Недостаточно денег');
    playerMoney -= item.price;
    grenadeCounts[w.id] = (grenadeCounts[w.id] || 0) + 1;
    ownedWeapons.add(w.id);
    // Picking a grenade off the buy menu plays the weapon-pickup sound (as in CS).
    if (typeof playSound === 'function')
      playSound(typeof PICKUP_SOUND !== 'undefined' ? PICKUP_SOUND : 'items/gunpickup2.wav', { volume: 0.8 });
    switchWeapon(idx);
    return _flashBuy(`Куплено: ${item.name}  −$${item.price}`);
  }
  if (playerMoney < item.price) return _flashBuy('Недостаточно денег');
  playerMoney -= item.price;
  // One weapon per slot — buying a new primary/secondary drops the old one (like CS):
  // it lands on the ground (with its current ammo) so it can be picked back up.
  if (w.slot === 'primary' || w.slot === 'secondary')
    for (const id of [...ownedWeapons]) {
      const o = WPNS.find(x => x.id === id);
      if (o && o.slot === w.slot && id !== w.id) {
        if (typeof _spawnPickup === 'function' && gsPos) _spawnPickup(id, o.ammo, o.reserve);
        ownedWeapons.delete(id);
      }
    }
  ownedWeapons.add(item.wid);
  if (w.maxAmmo) { w.ammo = w.maxAmmo; w.reserve = w._reserve0 ?? w.reserve; }   // full on (re)buy
  switchWeapon(idx);
  _flashBuy(`Куплено: ${item.name}  −$${item.price}`);
}

// Refill ammo for a slot (CS primary/secondary ammo categories buy one "fill").
function buyAmmo(slot) {
  if (typeof buyTimeOpen === 'function' && !buyTimeOpen()) return _flashBuy('Время закупки вышло');
  if (!inBuyZone()) return _flashBuy('Вы не в зоне закупки');
  const isGun = w => w.type === 'gun';
  const cand = WPNS.filter(w => isGun(w) && ownedWeapons.has(w.id) &&
    (slot === 'secondary' ? w.id === 'usp' : w.id !== 'usp'));
  const w = cand[0];
  if (!w) return _flashBuy('Нет оружия для патронов');
  const price = slot === 'secondary' ? 40 : 80;
  if (playerMoney < price) return _flashBuy('Недостаточно денег');
  if ((w.reserve ?? 0) >= (w._reserve0 ?? 0)) return _flashBuy('Патроны полны');
  playerMoney -= price;
  w.reserve = w._reserve0 ?? w.reserve;
  _flashBuy(`Патроны: ${w.label}  −$${price}`);
}

// Called by the weapon state machine when a throw animation finishes: consume one
// grenade of that type, then redeploy if any remain, else fall back to the best
// remaining weapon (primary > secondary > knife), as in CS.
function afterGrenadeThrow(wpn) {
  const id = wpn.grenadeType;
  grenadeCounts[id] = Math.max(0, (grenadeCounts[id] || 0) - 1);
  if (grenadeCounts[id] > 0) {
    ws = WS.DRAW; wsT = 0;                                 // redeploy another of the same type
    if (wpn.anim) { wpn.anim._drawAnimDone = false; wpn.anim.curFrame = 0; }
    return;
  }
  ownedWeapons.delete(id);
  let next = -1;
  for (const slot of ['primary', 'secondary', 'melee']) {
    const i = WPNS.findIndex(w => w.slot === slot && ownedWeapons.has(w.id));
    if (i >= 0) { next = i; break; }
  }
  if (next >= 0) { nextWpnIdx = next; _beginDraw(next); }
  else { ws = WS.IDLE; wsT = 0; }
}

// ── Buy menu (numeric, CS-style) ────────────────────────────────────────────
let buyOpen = false, _buyCat = -1;   // _buyCat: -1 = category list, else item list

function openBuyMenu() {
  if (typeof isLocked !== 'undefined' && !isLocked) return;
  if (teamStage) return;             // not during team select
  buyOpen = true; _buyCat = -1; _renderBuyMenu();
}
function closeBuyMenu() { buyOpen = false; document.getElementById('buymenu').style.display = 'none'; }

function buyMenuKey(n) {              // n: 0–9
  if (_buyCat < 0) {
    if (n === 0) { closeBuyMenu(); return; }
    if (n >= 1 && n <= BUY_CATALOG.length) {
      const cat = BUY_CATALOG[n - 1];
      if (cat.ammo) { buyAmmo(cat.ammo); _renderBuyMenu(); }   // ammo buys immediately, no submenu
      else { _buyCat = n - 1; _renderBuyMenu(); }
    }
  } else {
    if (n === 0) { _buyCat = -1; _renderBuyMenu(); return; }
    const slots = BUY_CATALOG[_buyCat].slots || [];
    if (n >= 1 && n <= slots.length) {                       // FIXED slot index (not renumbered)
      const it = _slotItem(slots[n - 1]);
      if (it) { buyItem(it); _renderBuyMenu(); }              // empty slot for this team → ignore
    }
  }
}

function _renderBuyMenu() {
  const el = document.getElementById('buymenu');
  const zone = inBuyZone();
  let rows;
  if (_buyCat < 0) {
    rows = BUY_CATALOG.map((c, i) => `<div class="bm-row"><span class="bm-k">${i + 1}</span> ${c.name}</div>`).join('');
    rows += `<div class="bm-row bm-back"><span class="bm-k">0</span> Закрыть</div>`;
  } else {
    const cat = BUY_CATALOG[_buyCat];
    rows = (cat.slots || []).map((slot, i) => {
      const it = _slotItem(slot);
      if (!it) return `<div class="bm-row bm-na"><span class="bm-k">${i + 1}</span> —</div>`;  // empty slot, number kept
      const buyable = it.wid || it.equip;
      const own = it.wid && ownedWeapons.has(it.wid);
      const ok  = buyable && playerMoney >= it.price && zone && !own;
      const cls = own ? 'bm-own' : (buyable ? (ok ? '' : 'bm-no') : 'bm-na');
      const tag = own ? 'есть' : (!buyable ? 'нет модели' : `$${it.price}`);
      return `<div class="bm-row ${cls}"><span class="bm-k">${i + 1}</span> ${it.name}<span class="bm-p">${tag}</span></div>`;
    }).join('');
    rows += `<div class="bm-row bm-back"><span class="bm-k">0</span> Назад</div>`;
    rows = `<div class="bm-cat">${cat.name}</div>` + rows;
  }
  el.innerHTML =
    `<div class="bm-head">ЗАКУПКА (${playerTeam.toUpperCase()}) &nbsp; $${playerMoney}` +
    `<span class="bm-zone">${zone ? 'в зоне закупки' : 'НЕ в зоне закупки'}</span></div>${rows}`;
  el.style.display = 'block';
}

// ── Team / class menu (old style) ───────────────────────────────────────────
let teamStage = null;        // null | 'team' | 'class'
let _pendTeam = null;

function openTeamMenu() { teamStage = 'team'; closeBuyMenu(); _renderTeamMenu(); }

function teamMenuKey(n) {
  if (teamStage === 'team') {
    if (n === 1) { _pendTeam = 't';  teamStage = 'class'; _renderTeamMenu(); }
    else if (n === 2) { _pendTeam = 'ct'; teamStage = 'class'; _renderTeamMenu(); }
    else if (n === 5) { _pendTeam = Math.random() < 0.5 ? 't' : 'ct'; _chooseClass(0); }
  } else if (teamStage === 'class') {
    const list = CLASSES[_pendTeam] || [];
    if (n >= 1 && n <= list.length) _chooseClass(n - 1);
  }
}

function _chooseClass(i) {
  const list = CLASSES[_pendTeam] || [];
  const cls = list[Math.min(i, list.length - 1)] || list[0];
  if (cls) playerModelName = cls.model;          // model loads (first time) below
  setTeam(_pendTeam);                            // spawn at the team's point + angle
  ownedWeapons.clear(); ownedWeapons.add('knife'); ownedWeapons.add('usp');
  playerMoney = START_MONEY;
  playerArmor = 0; playerHelmet = false; resetPlayerHealth();   // fresh body on join
  switchWeapon(WPNS.findIndex(w => w.id === 'usp'));   // spawn with the pistol out
  if (typeof loadPlayerModel === 'function') loadPlayerModel();   // deferred until class chosen
  teamStage = null;
  document.getElementById('teammenu').style.display = 'none';
  hasJoined = true;
  if (typeof netConnect === 'function') netConnect();   // join multiplayer relay (silent if none running)
  if (typeof startMatch === 'function') startMatch();   // begin the round flow (buy time → live → …)
  if (inBuyZone()) _flashBuy('B — купить оружие');
}

function _renderTeamMenu() {
  const el = document.getElementById('teammenu');
  let html;
  if (teamStage === 'team') {
    html = `<div class="tm-title">ВЫБОР КОМАНДЫ</div>` +
      `<div class="tm-row"><span class="tm-k">1</span> Террористы</div>` +
      `<div class="tm-row"><span class="tm-k">2</span> Контр-террористы</div>` +
      `<div class="tm-row"><span class="tm-k">5</span> Авто-выбор</div>`;
  } else {
    const list = CLASSES[_pendTeam] || [];
    html = `<div class="tm-title">ВЫБОР МОДЕЛИ — ${_pendTeam === 't' ? 'T' : 'CT'}</div>` +
      list.map((c, i) => `<div class="tm-row"><span class="tm-k">${i + 1}</span> ${c.name}</div>`).join('');
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

// HUD: money + buy hint, drawn each frame from updateHUD().
function updateBuyHUD() {
  const m = document.getElementById('money');
  if (m) { m.textContent = hasJoined ? `$${playerMoney}` : ''; }
  const msgEl = document.getElementById('buymsg');
  if (msgEl) {
    const age = (performance.now() - _buyMsgT) / 1000;
    if (_buyMsg && age < 2.2) { msgEl.textContent = _buyMsg; msgEl.style.opacity = Math.max(0, 1 - age / 2.2); }
    else msgEl.textContent = '';
  }
}
