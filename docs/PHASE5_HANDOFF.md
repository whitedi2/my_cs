# Фаза 5 (мультиплеер) — шпаргалка для продолжения

Состояние и следующий шаг, чтобы продолжить в новой сессии. Связанные документы:
`docs/PLAN.md` (фаза 5 — чекбоксы), `docs/DIFFERENCES.md`, `CLAUDE.md` (таблица файлов + запуск).

## Решение по архитектуре (выбрано пользователем)

- **Авторитетный сервер** (не relay). Клиент шлёт только **инпут** (usercmd: forward/side/jump/duck/
  кнопки/углы взгляда + seq#). Сервер крутит симуляцию, владеет HP/бронёй/раундами, делает хитрег.
  Клиент: **prediction + reconciliation** для себя, **интерполяция** для остальных.
- **Транспорт — WebRTC DataChannel**, режим `{ordered:false, maxRetransmits:0}` (= «браузерный UDP»).
  Проверено: `node-datachannel@^0.32.3` ставится готовым бинарником (без компилятора) и проходит
  loopback-тест DataChannel на **Node 23.11**. **WebSocket остаётся для signaling** (обмен SDP/ICE).
  STUN/TURN нужен только для интернета (на LAN/localhost хватает host-кандидатов).
- **npm разрешён для сервера** (есть `package.json`). Правило «no-npm» — только для браузерного клиента.
- **Переиспользуем `physics.js`** как общую детерминированную симуляцию: его ядро (`traceMove`/
  `playerMove`/`accel`/`friction`) использует THREE только в комментарии.

## Порядок работ (WebRTC — последним: это транспорт, не логика)

- **A.** Вынести ядро `physics.js` в общий инстансируемый `sim-core.js` (`playerMove(state, cmd, dt)`).
- **B.** Авторитетный тик на сервере из usercmd + prediction/reconciliation на клиенте — **поверх текущего
  WebSocket** (проверяемо в двух вкладках).
- **C.** Интерполяция чужих игроков (рендер на ~100 мс в прошлом, буфер снапшотов).
- **D.** Серверный хитрег + lag compensation (откат хитбоксов к моменту выстрела стрелка).
- **E.** Сменить транспорт на WebRTC DataChannel (WS → signaling), затем STUN/TURN под интернет.

## Что уже сделано (в рабочем дереве, НЕ закоммичено)

- **Статичные манекены убраны:** `src/enemy.js` `ENEMY_COUNT = 0` + ранний выход в `loadEnemy`.
  Машинерия инстансов (риг, OBB-хитбоксы, хитскан, урон, death-анимации) **оставлена** — переиспользуем
  для сетевых игроков (хитрег шага D).
- **Временный relay (будет переписан):**
  - `server.js` — zero-deps WebSocket-relay (RFC-6455 руками на `http`+`crypto`, порт 8081). Протестирован
    headless (хендшейк/join/leave/relay с id отправителя — ок).
  - `src/net.js` — relay-клиент: шлёт свой снапшот 20 Гц, рендерит удалённых игроков через `_buildRig`/
    `_skinRig`/`computeBoneWorlds`, lerp-интерполяция, походка по скорости.
  - Проводка: модуль в `viewer.html` (перед `load.js`), `netUpdate(dt)` в цикле `input.js`,
    `netConnect()` в `game.js _chooseClass`.
- **npm для сервера:** `package.json` + установлен `node-datachannel` (проверен на Node 23.11).

## Следующий шаг = A: `sim-core.js`

Цель: клиент и сервер крутят **один и тот же** код движения. Сначала серверную часть + **headless-тест**
(без риска для рабочей одиночки).

Портировать из `src/physics.js` (чистая математика по массивам):
- `pointContents` (~стр. 16), `_check` (~27), `traceMove` (~65);
- `playerMove` + `accel`/`applyFriction`/`categorize`/`slideMove` + логика приседа.
- **ИСКЛЮЧИТЬ** хвост камеры (`yawObj.position.set`, `smoothCamY`) — это клиентское.
- Константы: `CONTENTS_SOLID=-2`, `DIST_EPS=0.03125`, `SV`/`CONFIG` (`config.js`: gravity 800, maxspeed,
  accelerate, friction, stopspeed, jumpvel, eyestand/eyeduck, ducktime, stairSmoothing).

Рефактор: функции принимают **явный объект состояния** вместо модульных `let` (`gsPos,vel,onGround,
duckAmount,phyDucked,…`), а халл **передаётся** (не глобали `gPlanes/gClipnodes/gHullHead*`).

Халл: `maps/de_dust2_hull.json` — `clipnodes` = `[planeIdx, child1, child2]`, `planes` = `[a,b,c,d]`
(плоскость `a*x+b*y+c*z - d`); есть stand hull1 + duck hull3, спауны, `buyZones`, `bombsites`. Разбор и
выбор hull-head см. в `initPhysics` (`physics.js`).

**Dual-mode `sim-core.js`:** классический браузерный скрипт (объявляет глобали) + в конце
`if (typeof module !== 'undefined') module.exports = { … }` для `require` на сервере.

**Headless-тест:** загрузить халл JSON, прогнать игрока несколько тиков (шаг вперёд, падение на пол),
проверить коллизию/приземление.

## На другом компьютере (важно)

- Авто-память агента лежит локально на старой машине и **не переедет** — этот файл (`docs/PHASE5_HANDOFF.md`)
  и есть источник правды. В новой сессии скажи «продолжаем фазу 5, см. docs/PHASE5_HANDOFF.md».
- `node_modules/` в git не коммитится — на новой машине выполнить **`npm install`** (поднимет
  `node-datachannel` из `package.json`).
- `node-datachannel` проверялся на **Node 23.11** (готовый бинарник). Если на новой машине другая версия
  Node — заново прогнать loopback-тест DataChannel; если пребилда нет, может потребоваться сборка
  (cmake/VS Build Tools) либо переход на чистый JS-вариант (`werift`).
- Запуск: `python serve.py` (статика :8080) + `node server.js` (relay :8081), `viewer.html` в двух вкладках.

## Подводный камень №1 — координаты

GoldSrc `(x,y,z)` Z-up ↔ Three.js `(x, z, -y)`. Симуляция целиком в GoldSrc-пространстве; конвертация
только на рендере.

## Память агента

Те же факты продублированы в авто-памяти: `phase5-netcode-decision`, `phase5-progress-handoff`
(в новой сессии подхватятся из `MEMORY.md`).
