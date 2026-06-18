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

- **A.** ✅ ГОТОВО. Ядро вынесено в `src/sim-core.js` (детерминированное, состояние/халл передаются явно).
  Headless-тест `tools/sim_test.js` (зелёный: падение→приземление, ходьба, прыжок). Подключён в `viewer.html`.
- **B.** ✅ ГОТОВО. Авторитетный сервер (`server.js`) крутит `simPlayerMove` из usercmd, рассылает
  снапшоты 20 Гц + `ack`. Клиент (`physics.js`+`net.js`): prediction локально + reconciliation (ресет
  к авторитетному + переигрывание неподтверждённых cmd). Тесты: `tools/net_test.js`, `tools/net_smoke.js`.
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

## A — что сделано (готово)

`src/sim-core.js` — общий детерминированный движок движения (dual-mode: классический браузерный
скрипт + `module.exports` для Node). Чистая математика, **состояние и халл передаются явно**:
- `simMakeHull(json)` → объект халла (stand/duck heads + entity solid heads).
- `simMakeState(pos)` → `{pos,vel,onGround,wasJump,duckAmount,phyDucked,prevVelZ}`.
- `simTraceMove(hull, ducked, from, to)`, `simPointContents`, `simCategorize`.
- `simPlayerMove(hull, st, cmd, dt, params)` — один тик. `cmd = {forwardMove,sideMove,jump,duck,
  walk,yaw}` (usercmd), `params.wpnMax` — кап скорости оружия. Возвращает события
  `{jumped, landed, fallVel}` — **side-effects (урон от падения, HP) делает вызывающий (сервер)**,
  сам движок HP не трогает. Исключён клиентский хвост: камера/recoil/punch остались в `physics.js`.
- `config.js` теперь dual-mode (`module.exports = CONFIG`) — единый источник констант для Node.
- Подключён в `viewer.html` (между `physics.js` и `game.js`; имена с префиксом `sim*`/`SIM_` — без
  коллизий с `physics.js`).
- Тест: `node tools/sim_test.js` (падение→приземление без провала, ходьба двигает, прыжок взлетает/садится).

## B — что сделано (готово)

Авторитетный сервер + prediction/reconciliation поверх текущего WebSocket:
- **`server.js` — авторитетный** (был relay). Держит `simMakeState` на игрока, принимает usercmd, крутит
  `simPlayerMove`, рассылает `snap` 20 Гц + `ack` (последний обработанный seq). Мир-логика вынесена
  в чистые экспорты (`createWorld/worldAddPlayer/worldRespawn/worldApplyCmd/worldSnapshot`); сеть
  стартует только при `node server.js` (`require.main`). Грузит халл + `config.js` через require.
- **`physics.js` переписан поверх sim-core**: `playerMove` строит usercmd из ввода, зовёт `simPlayerMove`
  (одинаковый код с сервером), затем клиентский хвост (punch/recoil/камера). Одиночка идёт тем
  же ядром (нет сервера → хуки net* — no-op). `simHull` строится в `initPhysics`.
- **`net.js`:** шлёт usercmd (`netRecordCmd`), хранит кольцо `_pending`, на `snap` делает reconciliation
  (`netReconcile`: ресет к `_authState` + переигрывание cmd с `seq>ack`), удалённых интерполирует.
  `netHello` шлёт spawn-позу при join/респауне (из `respawn()`), чтобы сервер не тянул назад.
- **Протокол:** клиент→сервер `{t:'hello',m,tm,p,y}` и `{t:'cmd',seq,dt,fm,sm,jp,dk,wk,y,ws}`;
  сервер→клиент `{t:'welcome',id}`, `{t:'snap',ack,players:[{id,p,v,y,og,dk,da,wj,pz,m,tm}]}`, `{t:'leave',id}`.
- **Тесты:** `node tools/net_test.js` (авторитет == standalone sim-core, stale/dup seq, формат
  снапшота), `node tools/net_smoke.js` (реальный WS: хендшейк→welcome→hello→cmd→snap, ack растёт,
  движение идёт). `npm test` гоняет все три.

**Осталось/упрощено (см. DIFFERENCES):** HP/урон от падения пока клиентские; `wpnMax` (кап скорости)
клиент шлёт в cmd (сервер доверяет); cmd шлётся каждый кадр (не батчится). Стрельба по игрокам — шаг D.

## Следующий шаг = C: интерполяция чужих (рендер на ~100 мс в прошлом)

Сейчас удалённые игроки лерпятся к последнему снапшоту (`_updateRemote`, `k=dt*14`) — работает, но при
потерях/джиттере дёргает. Надо: буфер снапшотов с таймштампами, рендер остальных игроков
на ~100 мс в прошлом (интерполяция между двумя окружающими снапшотами), extrapolation на короткие
пробелы. Потом шаг D (серверный хитрег + lag compensation) и E (WebRTC).

Халл/спауны: `maps/de_dust2_hull.json` (`clipnodes=[planeIdx,c1,c2]`, `planes=[a,b,c,d]`; stand hull1 +
duck hull3, спауны, `buyzones`, `bombsites`).

## На другом компьютере (важно)

- Авто-память агента лежит локально на старой машине и **не переедет** — этот файл (`docs/PHASE5_HANDOFF.md`)
  и есть источник правды. В новой сессии скажи «продолжаем фазу 5, см. docs/PHASE5_HANDOFF.md».
- `node_modules/` в git не коммитится — на новой машине выполнить **`npm install`** (поднимет
  `node-datachannel` из `package.json`).
- `node-datachannel` проверялся на **Node 23.11** (готовый бинарник). Если на новой машине другая версия
  Node — заново прогнать loopback-тест DataChannel; если пребилда нет, может потребоваться сборка
  (cmake/VS Build Tools) либо переход на чистый JS-вариант (`werift`).
- Запуск: `python serve.py` (статика :8080) + `node server.js` (авторитетный :8081), `viewer.html` в двух вкладках.

## Подводный камень №1 — координаты

GoldSrc `(x,y,z)` Z-up ↔ Three.js `(x, z, -y)`. Симуляция целиком в GoldSrc-пространстве; конвертация
только на рендере.

## Память агента

Те же факты продублированы в авто-памяти: `phase5-netcode-decision`, `phase5-progress-handoff`
(в новой сессии подхватятся из `MEMORY.md`).
