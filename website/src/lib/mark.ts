/**
 * The haus mark on a 64 x 64 grid: a cozy little house with two puffs of smoke
 * drifting from its chimney, a small one and a bigger one. Walls and roof bow slightly; every joint lands exactly on the line
 * it meets (computed from the roof curves), so nothing overshoots.
 */
export const mark = {
  roof: "M8 34.5 Q17.93 23.17 29.4 13.4 Q32 11.2 34.6 13.4 Q46.07 23.17 56 34.5",
  body:
    "M15.2 26.7 Q14.5 40.45 15.2 52 Q15.2 54.2 17.4 54.2 H27 V43.2 A5 5 0 0 1 37 43.2 V54.2 H46.6 " +
    "Q48.8 54.2 48.8 52 Q49.5 40.45 48.8 26.7",
  chimney: "M42.4 20.39 V15.2 Q42.4 13.6 44 13.6 H46.4 Q48 13.6 48 15.2 V25.88",
  window: { cx: 32, cy: 24.6, r: 2.5 },
  puffs: [
    { cx: 45.6, cy: 9.3, r: 1.5 },
    { cx: 48.7, cy: 4.3, r: 2.3 },
  ],
} as const;
