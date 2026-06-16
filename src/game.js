// game.js — team/class selection, money, weapon ownership, buy menu.
// Classic script, shared global scope. Loads after physics (needs gsPos / buyZones /
// playerTeam / setTeam) and weapons (WPNS / switchWeapon) and player (playerModelName);
// before input (which opens these menus and routes keys to them).

const START_MONEY = 16000;
let playerMoney = START_MONEY;
const ownedWeapons = new Set(['knife', 'usp']);   // default loadout: knife + pistol
let hasJoined = false;                            // chosen a team/class yet?

WPNS.forEach(w => { w._reserve0 = w.reserve; });  // remember full reserve for buy refills

// ── CS 1.6 buy catalog ──────────────────────────────────────────────────────
// Same categories/order/key-combos as the original menu (B → category → item).
// `teams` = which side may buy it (canonical CS restrictions; the menu shows only
// your team's items, renumbered 1..N — exactly like the real buy menu). Prices are
// the verified CS 1.6 values. `wid` = WPNS id when we have a working model (buyable);
// items without `wid` show the price + "нет модели" and can't be bought yet.
const B = ['ct', 't'];   // both teams
const BUY_CATALOG = [
  { name: 'Пистолеты', items: [
    { name: 'Glock-18',         price: 400,  teams: B, wid: 'glock18' },
    { name: 'USP .45 Tactical', price: 500,  teams: B, wid: 'usp' },
    { name: 'P228 Compact',     price: 600,  teams: B, wid: 'p228' },
    { name: 'Desert Eagle',     price: 650,  teams: B, wid: 'deagle' },
    { name: 'Five-SeveN',       price: 750,  teams: ['ct'], wid: 'fiveseven' },
    { name: 'Dual Berettas',    price: 800,  teams: ['t']  },
  ] },
  { name: 'Дробовики', items: [
    { name: 'M3 Super 90',      price: 1700, teams: B },
    { name: 'XM1014',           price: 3000, teams: B },
  ] },
  { name: 'Пистолеты-пулемёты', items: [
    { name: 'MP5 Navy',         price: 1500, teams: B, wid: 'mp5' },
    { name: 'TMP',              price: 1250, teams: ['ct'], wid: 'tmp' },
    { name: 'MAC-10',           price: 1400, teams: ['t'],  wid: 'mac10' },
    { name: 'UMP45',            price: 1700, teams: B, wid: 'ump45' },
    { name: 'P90',              price: 2350, teams: B, wid: 'p90' },
  ] },
  { name: 'Винтовки', items: [
    { name: 'Galil',            price: 2000, teams: ['t'],  wid: 'galil' },
    { name: 'FAMAS',            price: 2250, teams: ['ct'], wid: 'famas' },
    { name: 'AK-47',            price: 2500, teams: ['t'],  wid: 'ak47' },
    { name: 'M4A1 Carbine',     price: 3100, teams: ['ct'], wid: 'm4' },
    { name: 'SG-552 Commando',  price: 3500, teams: ['t'],  wid: 'sg552' },
    { name: 'Steyr AUG',        price: 3500, teams: ['ct'], wid: 'aug' },
    { name: 'Steyr Scout',      price: 2750, teams: B },
    { name: 'SG-550 Auto',      price: 4200, teams: ['ct'] },
    { name: 'G3/SG-1 Auto',     price: 5000, teams: ['t']  },
    { name: 'AWP',              price: 4750, teams: B },
  ] },
  { name: 'Пулемёты', items: [
    { name: 'M249 Para',        price: 5750, teams: B, wid: 'm249' },
  ] },
  { name: 'Боезапас (основной)',  ammo: 'primary',   items: [] },
  { name: 'Боезапас (пистолет)',  ammo: 'secondary', items: [] },
  { name: 'Снаряжение', items: [
    { name: 'Кевлар',                 price: 650,  teams: B },
    { name: 'Кевлар + Шлем',          price: 1000, teams: B },
    { name: 'Флешка',                 price: 200,  teams: B },
    { name: 'Граната HE',             price: 300,  teams: B },
    { name: 'Дымовая граната',        price: 300,  teams: B },
    { name: 'Дефуз-кит',              price: 200,  teams: ['ct'] },
    { name: 'Прибор ночного видения', price: 1250, teams: B },
  ] },
];

// Items shown to the current team in a category (filtered + original order).
function _catItems(cat) {
  return (cat.items || []).filter(it => !it.teams || it.teams.includes(playerTeam));
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
  if (item.teams && !item.teams.includes(playerTeam)) return _flashBuy('Недоступно вашей команде');
  if (!inBuyZone())     return _flashBuy('Вы не в зоне закупки');
  if (!item.wid)        return _flashBuy('Нет модели — недоступно');
  const idx = WPNS.findIndex(w => w.id === item.wid);
  if (idx < 0)          return _flashBuy('Оружие недоступно');
  if (playerMoney < item.price) return _flashBuy('Недостаточно денег');
  playerMoney -= item.price;
  const w = WPNS[idx];
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
    const items = _catItems(BUY_CATALOG[_buyCat]);
    if (n >= 1 && n <= items.length) { buyItem(items[n - 1]); _renderBuyMenu(); }
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
    rows = _catItems(cat).map((it, i) => {
      const own = it.wid && ownedWeapons.has(it.wid);
      const ok  = it.wid && playerMoney >= it.price && zone && !own;
      const cls = own ? 'bm-own' : (it.wid ? (ok ? '' : 'bm-no') : 'bm-na');
      const tag = own ? 'есть' : (!it.wid ? 'нет модели' : `$${it.price}`);
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
  switchWeapon(WPNS.findIndex(w => w.id === 'usp'));   // spawn with the pistol out
  if (typeof loadPlayerModel === 'function') loadPlayerModel();   // deferred until class chosen
  teamStage = null;
  document.getElementById('teammenu').style.display = 'none';
  hasJoined = true;
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
