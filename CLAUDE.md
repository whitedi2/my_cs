# CS 1.6 Browser Clone — гайд для агентов

Браузерный клон механик Counter-Strike 1.6 на **Three.js**: карта de_dust2, движение игрока по
оригинальной физике GoldSrc, оружие со скелетной анимацией (M4A1, USP, нож), отдача/разброс,
гильзы, вспышки, декали попаданий. Чистый клиент — без сборки, без npm, без бэкенда.

## Запуск

```bash
python serve.py          # поднимает http://localhost:8080/viewer.html и открывает браузер
```

Нужен HTTP-сервер (не `file://`) — иначе не загрузятся `.json`/ассеты и ES-модуль Three.js.
Three.js тянется с CDN через `<script type="importmap">` в `viewer.html` — **нужен интернет**.

Проверка изменений = перезагрузить страницу в браузере (Ctrl+Shift+R: декали/текстуры
кэшируются) и посмотреть глазами. Скриншот-тесты не используем.

## Где что лежит

`viewer.html` — тонкая оболочка: разметка (overlay/HUD/настройки), стили, importmap и **загрузчик**.
Загрузчик (`<script type="module">` в конце) импортирует Three.js + лоадеры и кладёт их в `window`
(`window.THREE/OBJLoader/MTLLoader`), затем последовательно грузит `src/*.js` как **классические
скрипты**. Все `src/*.js` делят **один глобальный scope** (как старый единый инлайн-скрипт): общие
`const/let`/функции видны между файлами. Поэтому в `src/*.js` **нет import/export** — THREE и лоадеры
берутся как глобалы.

Runtime разбит по файлам (порядок загрузки = порядок в массиве `modules` в `viewer.html`):

| Файл | Содержимое | Ключевые функции / якоря |
|---|---|---|
| `src/scene.js` | рендерер, сцены (мир / вьюмодель / 2D-вспышка), камеры, muzzle flash | `vmScene`, `_flashScene2D`, `_showFlash`, `_tickFlash`, `_loadAdditiveSprite` |
| `src/audio.js` | звук из оригинала (WebAudio): выстрел/нож из кода, перезарядка/деплой/глушитель по MDL-событиям, шаги/приземление (материал по `materials.txt` + трасса пола, каденс по скорости — `pm_shared.c`) | `initAudio`, `playSound`, `playRandom`, `warmWeaponSounds`, `_tickAnimEvents`, `updateMovementSounds`, `setMasterVolume` |
| `src/effects.js` | гильзы + декали пуль/ножа | `_ejectShell`, `_updateShells`, `_spawnDecal`, `_getDecalMat`, `_makeSlashTexture`, `_drawTaperedCut` |
| `src/weapons.js` | конфиги оружия, переключение, скелетка, стрельба/отдача, ближний бой | `WPNS`, `switchWeapon`, `_beginDraw`, `toggleSilencer`, `updateWeapon` (стейт-машина `ws`), `applySkeletalAnimation`, `computeBoneWorlds`, `boneEulerMat`, `_startMeleeAttack` |
| `src/player.js` | модель игрока от 3-го лица (CT `gign`, `PLAYER_MODEL`): двухслойная анимация (ноги=походка, верх=прицел/стрельба/перезарядка по оружию), оружие в руке, чейз-камера с орбитой | `updatePlayerModel`, `_skinRig`, `_updateWeaponAttachment`, `_resolveUpperPose`/`_aimPose`/`_clipPose`, `updateChaseCamera`, `updateOrbit`, `toggleThirdPerson`, `thirdPerson` |
| `src/hud.js` | прицел и HUD | `drawCrosshair`, `updateHUD` |
| `src/physics.js` | BSP-трасса + физика игрока; точки спауна/угол, зоны закупки, выбор команды | `pointContents`, `traceMove`, `playerMove`, `slideMove`, `categorize`, `accel`, `applyFriction`, `initPhysics`, `pickSpawn`, `respawn`, `setTeam`, `spawnPoints`, `buyZones` |
| `src/game.js` | состояние матча: команда/класс-меню, деньги, владение оружием, закупка, гранаты-счётчики (после physics/weapons/player) | `BUY_CATALOG`, `CLASSES`, `buyItem`, `inBuyZone`, `openBuyMenu`/`buyMenuKey`, `openTeamMenu`/`teamMenuKey`, `ownedWeapons`, `grenadeCounts`, `afterGrenadeThrow`, `playerMoney`, `updateBuyHUD` |
| `src/grenades.js` | гранаты (HE/флеш/дым): бросок, физика снаряда (`w_*` + отскок по BSP), запал, детонация (радиус-урон / слепота / дым), эффекты (после game) | `throwGrenade`, `updateGrenades`, `_moveGrenade`, `_detonateHE`/`_detonateFlash`/`_detonateSmoke`, `_updateBlind`, `_updateSmokes`, `clearGrenades`, `GRENADE_DEFS` |
| `src/pickups.js` | дроп (G) и подбор оружия: мировая `p_*`-модель падает на пол, подбор по близости со звуками оригинала (после game.js) | `dropWeapon`, `updatePickups`, `_spawnPickup`, `_buildDropModel`, `DROP_SOUND`/`PICKUP_SOUND` |
| `src/load.js` | загрузка карты/ассетов (после physics, чтобы `initPhysics` была определена) | `objPromise`, `hullPromise`, `Promise.all(...).then(...)` |
| `src/input.js` | pointer lock, настройки, мышь/клавиатура/оружие, **главный цикл** | `animate(t)`, `updateFOV`, обработчики ввода, `animate(0)` в конце |

**Конфиг физики/управления:** `config.js` (глобальный `const CONFIG`, грузится классическим тегом до
загрузчика). Тут `gravity, maxspeed, jumpvel, eyestand/eyeduck, ducktime, sensitivity, stairSmoothing`,
дефолты настроек.

**Координаты:** GoldSrc `(x,y,z)` Z-up ↔ Three.js `(x, z, -y)` — **главный источник багов**.

**Если добавляешь новый `src/*.js`** — впиши его в массив `modules` в `viewer.html` в нужном порядке
(зависимости по top-level коду должны грузиться раньше; функции резолвятся в рантайме, порядок между
ними не важен).

## Структура проекта

```
viewer.html        оболочка: разметка, importmap, загрузчик src/*.js
config.js          глобальный CONFIG (физика, мышь, дефолты настроек)
serve.py           локальный сервер (python serve.py)
CLAUDE.md          этот файл
src/               рантайм JS (классические скрипты, общий global scope)
maps/              карта de_dust2 — самодостаточна:
  de_dust2.obj/.mtl, de_dust2_hull.json (коллизия), de_dust2_lm.*, de_dust2_uv2.bin
  textures/        ← текстуры карты (.mtl ссылается на textures/… → maps/textures/…)
models/            меши вьюмоделей и гильз: v_<weapon>{,_anim,_sil}.json, rshell/pshell.json
textures/          текстуры ОРУЖИЯ (json texFile="textures/…" резолвится от корня)
sprites/           кадры muzzleflash (PNG)
sounds/            звуки из оригинала (.wav, раскладка GoldSrc: weapons/, items/, player/) + materials.txt (текстура→материал шага)
decals/            PNG следов пуль (shot1..5); следы ножа — процедурные (не из PNG)
tools/             Python-конвейер (см. ниже) + config.py
docs/              PLAN.md, DIFFERENCES.md
```

## Ассеты (предсгенерированы из оригинальных файлов GoldSrc)

- **`maps/`** — карта самодостаточна: `de_dust2.obj` (+`.mtl`, ~40 МБ), её текстуры в
  `maps/textures/`, `de_dust2_hull.json` (clipnodes/planes BSP: hull1 стоя, hull3 присед).
  Грузится в `src/load.js` через `MTLLoader.setPath('maps/')` — поэтому `textures/…` в `.mtl`
  резолвится в `maps/textures/`. `_lm.*`/`_uv2.bin` рантаймом сейчас не используются.
- **`models/`** — `v_<weapon>.json` (меши), `v_<weapon>_anim.json` (кости+анимации), `_sil`
  (с глушителем), `rshell/pshell.json` (гильзы). Пути прописаны в `WPNS` (`src/weapons.js`) и
  в `src/effects.js`. Поле `texFile` внутри = `"textures/…"` → резолвится от корня (**`textures/`**).
- **`textures/`** (корень) — текстуры оружия/гильз. **`sprites/`** — muzzleflash. **`decals/`** —
  следы пуль. Эти три каталога ссылаются относительными URL от корня — поэтому остаются в корне.

## Конвейер ассетов (Python в `tools/`, запускать вручную по необходимости)

Скрипты тянут оригиналы из `tools/config.py` (`CSTRIKE_PATH`, Steam Half-Life/cstrike). Запуск из
корня проекта: `python tools/<script>.py`. Выходные пути уже указывают в нужные каталоги:

- `mdl_to_json.py` — MDL → `models/v_*.json` (+ текстуры оружия в `textures/`).
- `extract_anim.py` — анимации → `models/v_*_anim.json` (включая звуковые **события** MDL: event
  5004 → `events:[{frame,sound}]` в каждой секвенции — оригинальный тайминг перезарядки/деплоя/глушителя).
- `extract_sounds.py` — звуки → `sounds/` (раскладка GoldSrc) + `materials.txt`. Собирает имена
  автоматически: событийные (5004) из всех `v_*.mdl` + код-зависимые (выстрел/нож + шаги/приземление
  игрока) из списков в скрипте.
- `player_to_json.py` — модель игрока (`models/player/<name>/<name>.mdl`) → `models/player_<name>.json`
  (меш тела + кости + хитбоксы `mstudiobbox_t` (OBB по костям, поле `hitboxes`) + только движенческие
  секвенции idle/walk/run/crouch/jump) + текстуры в `textures/player_*`.
  Сейчас сконвертирован CT `gign` (`python tools/player_to_json.py gign`); модель в рантайме
  выбирается константой `PLAYER_MODEL` в `src/player.js`.
- `pweapon_to_json.py` — мировая модель оружия `p_<weapon>.mdl` → `models/p_<weapon>.json`
  (меш ствола + кости `Bip01…` + bind-поза). Рантайм гонит этот скелет позой игрока (по имени кости),
  оружие крепится к кисти. Готовы `p_m4a1`, `p_usp`, `p_knife`.
- `bsp_to_obj.py` — BSP → `maps/de_dust2.obj/.mtl` + `maps/textures/`.
- `bsp_phys.py` — BSP → `maps/de_dust2_hull.json`.
- `extract_spr.py` → `sprites/`, `extract_decals.py` → `decals/` (пути в этих двух — абсолютные, поправь под себя).
- `extract_skin.py`, `list_wad.py`, `debug_wad.py`, `_*.py` — вспомогательные/отладочные.

## Соглашения и подводные камни

- **Координаты:** при любом переносе позиции/направления между физикой (GoldSrc) и рендером (Three.js)
  применяй `(x,y,z)_gs → (x, z, -y)_three`. Луч декалей/попаданий строится из `yaw`/`pitch` именно так.
- **Общие мутабельные глобалы:** состояние игрока (`gsPos, vel, yaw, pitch, onGround, duckAmount,
  phyDucked, recoilPitch/Yaw, punchRoll, ws, …`) — это модульные `let`, ими делятся все функции.
- **Декали = физика попадания:** `_spawnDecal` сам рейкастит визуальный меш вдоль реального взгляда
  (с отдачей+разбросом) — точка следа и есть точка попадания. Материал — `MultiplyBlending`
  (тёмное затемняет стену, белое = идентичность); обязательно `toneMapped:false, fog:false`,
  иначе белый фон затемняет весь квад. Нормаль грани разворачивается к стрелку.
- **Отдача vs разброс:** «движение экрана» (`recoilPitch/Yaw` → камера) и «разброс пуль» (конус в
  `_spawnDecal`, только декаль) — независимы. M4 — процедурный T-паттерн (`recoilProc`, KickBack со
  случайной сменой стороны), USP — вертикальный `recoilKick` + растущий конус разброса.
- **Landing punch:** только крен (roll), без кивка; срабатывает лишь при приземлении в приседе
  (`duckAmount>0.5`); угол ставится мгновенно, выравнивается плавно (`punchRoll *= exp(-dt*4)`).
- **Анти-фолл-тру:** `slideMove` не принимает ход «сквозь солид» при `startsolid`/`allsolid`
  (выталкивает вверх). Не убирать — иначе провал сквозь горки/ящики.
- **Цель — перенести оригинальные механики CS 1.6, не выдумывать свои.** Числа и формулы геймплея
  (урон оружия, спад по дистанции, множители hitgroup, броня, отдача/разброс, тайминги, физика) берём
  из оригинала: ассеты GoldSrc (MDL/BSP/SPR) и логика из **ReGameDLL_CS** (точная реверс-реализация
  game-dll) / HLSDK. Не подбирать «на глаз», если можно свериться с источником. Любое сознательное
  или вынужденное расхождение — фиксировать в `docs/DIFFERENCES.md` (и помечать приближения 🔹).
  Если для механики нет данных в оригинале — спросить, а не сочинять.
- **Только оригинальная анимация — никакой отсебятины.** Анимация модели/оружия должна браться из
  оригинальных MDL CS 1.6 (или, как запас, из Half-Life GoldSrc). Не выдумывать движения и не
  синтезировать жесты, которых нет в исходных секвенциях. Если нужного движения в модели нет — спросить,
  а не сочинять. (Допустимо: кросс-фейд/слёрп между *существующими* позами, как делает движок — это не
  новая анимация, а интерполяция оригинальных.)
- Никакой сборки/линтера/тестов — правки идут прямо в `viewer.html`, проверка глазами в браузере.

## Документы

- `docs/PLAN.md` — исходный план разработки (фазы, параметры физики из оригинала).
- `docs/DIFFERENCES.md` — намеренные/вынужденные отличия от оригинала CS 1.6 (следы ножа, присед,
  третье лицо и т.д.). Обновлять при любом сознательном расхождении с оригиналом.
