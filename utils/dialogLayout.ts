/** The tallest a centred dialog may be: the window, less the safe insets and a margin on each side. Never below `floor`. Pure. */
export function dialogMaxHeight(windowHeight: number, insetTop: number, insetBottom: number, margin: number, floor = 240): number {
  const h = windowHeight - Math.max(0, insetTop) - Math.max(0, insetBottom) - 2 * Math.max(0, margin);
  return Math.max(floor, Number.isFinite(h) ? h : floor);
}
