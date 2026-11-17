/** The clock face on "Downloads usually finish": one hand on a 12-hour dial, a tiny moon for pm and sun for am. Pure. */

/** Degrees clockwise from 12 o'clock for an hour of the day (0 to 23). 3 and 15 are both 90. */
export const handAngle = (hour: number): number => ((((Math.round(hour) % 12) + 12) % 12) / 12) * 360;

/** pm (12 to 23) shows the moon; am shows the sun. */
export const isPm = (hour: number): boolean => hour >= 12;

/** The hand's tip as a whole-pixel offset from the dial centre; y grows downward. */
export function handTip(hour: number, length: number): { dx: number; dy: number } {
  const a = (handAngle(hour) * Math.PI) / 180;
  const z = (v: number) => (Object.is(v, -0) ? 0 : v);
  return { dx: z(Math.round(length * Math.sin(a))), dy: z(Math.round(-length * Math.cos(a))) };
}
