const CONFIG = {

  // ── Физика (GoldSrc/CS 1.6 значения) ─────────────────────────────────────
  gravity:      800,
  maxspeed:     250,    // обычный бег
  walkspeed:    130,    // тихая ходьба (Shift)
  crouchspeed:  90,     // бег в приседе
  accelerate:   5,      // sv_accelerate
  airaccel:     10,     // sv_airaccelerate
  friction:     4,      // sv_friction
  stopspeed:    75,     // sv_stopspeed
  jumpvel:      245,    // начальная вертикальная скорость прыжка
  stepsize:     18,     // высота ступеньки (hull1 half-height / 2)
  eyestand:     17,     // высота глаз от origin стоя  (GoldSrc VEC_VIEW_OFS = 17)
  eyeduck:     -6,      // высота глаз от origin в приседе (GoldSrc VEC_DUCK_VIEW = 12 → floor+30)
  ducktime:     0.2,    // секунды на полный присед
  uncrouchtime: 0.03,   // секунды на полное вставание

  // ── Мышь ─────────────────────────────────────────────────────────────────
  sensitivity:  0.0018, // множитель movementX/Y → радианы

  // ── Камера ───────────────────────────────────────────────────────────────
  stairSmoothing: 18,   // коэффициент экспоненциального сглаживания камеры на ступенях
                        // (выше = резче, ниже = плавнее)

  // ── Настройки по умолчанию ────────────────────────────────────────────────
  widescreenFOV: true,  // широкоэкранный FOV (90° по горизонту 4:3, растянутый на 16:9)
  invertY:       true,
  rightHand:     true,
  dynamicCrosshair: false, // cl_dynamiccrosshair: расширение от ДВИЖЕНИЯ (от стрельбы — всегда)

};

// Dual-mode: in the browser this loads as a classic script (CONFIG is a global);
// in Node (server / headless sim tests) sim-core.js requires it as the source of
// truth for the physics constants. Guarded so the browser never sees `module`.
if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
