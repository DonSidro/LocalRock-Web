/*
 * The single transform every part of the map goes through (LocalRock's MapView.kt), so nothing can
 * drift out of step: the floor, the 3D wall layers, the route, the labels and a tap's hit test.
 *
 * A point in cell space (x right, y down, one unit per 50 mm cell) is turned by yawDeg about the
 * floor plan's centre, squashed vertically by squash for a tilted camera (1 is straight down), then
 * scaled by k (screen px per cell) and moved by pan. lift is how far one cell of height rises on screen.
 */
export class MapTransform {
  private readonly cos: number;
  private readonly sin: number;
  readonly lift: number;

  constructor(
    readonly canvasW: number,
    readonly canvasH: number,
    readonly centerX: number,
    readonly centerY: number,
    readonly k: number,
    readonly panX: number,
    readonly panY: number,
    readonly yawDeg: number,
    readonly squash: number,
  ) {
    const r = (yawDeg * Math.PI) / 180;
    this.cos = Math.cos(r);
    this.sin = Math.sin(r);
    this.lift = Math.sqrt(Math.max(0, 1 - squash * squash));
  }

  toScreen(x: number, y: number, height = 0): { x: number; y: number } {
    const dx = x - this.centerX;
    const dy = y - this.centerY;
    const rx = dx * this.cos - dy * this.sin;
    const ry = (dx * this.sin + dy * this.cos) * this.squash;
    return { x: this.canvasW / 2 + this.panX + rx * this.k, y: this.canvasH / 2 + this.panY + ry * this.k - height * this.k * this.lift };
  }

  /** The point on the floor under a screen position; the inverse of toScreen at height 0. */
  toCell(sx: number, sy: number): { x: number; y: number } {
    const x = (sx - this.canvasW / 2 - this.panX) / this.k;
    const y = (sy - this.canvasH / 2 - this.panY) / this.k / this.squash;
    return { x: this.centerX + x * this.cos + y * this.sin, y: this.centerY - x * this.sin + y * this.cos };
  }

  /**
   * The canvas matrix (a, b, c, d, e, f) that draws a layer of `scale` pixels per cell at `height`
   * cells above the floor, for ctx.setTransform after multiplying by the device pixel ratio.
   */
  layerMatrix(scale: number, height = 0): [number, number, number, number, number, number] {
    const a = (this.k * this.cos) / scale;
    const b = (this.k * this.squash * this.sin) / scale;
    const c = (-this.k * this.sin) / scale;
    const d = (this.k * this.squash * this.cos) / scale;
    const o = this.toScreen(this.centerX, this.centerY, height);
    // The layer's pixel (cx, cy) * scale lands on o.
    const e = o.x - (a * this.centerX + c * this.centerY) * scale;
    const f = o.y - (b * this.centerX + d * this.centerY) * scale;
    return [a, b, c, d, e, f];
  }
}

/** The 3D camera's tip from looking straight down, in degrees. Past about 75 the floor is a sliver. */
export const MAP_3D_MAX_TILT = 75;
// A three-quarter view, so a first look at the 3D map shows two faces of every wall.
export const DEFAULT_3D_YAW = 35;
export const DEFAULT_3D_TILT = 53;

/** How much a floor squashes vertically when the camera is tipped tiltDeg off straight down. */
export const squashForTilt = (tiltDeg: number) => Math.cos((tiltDeg * Math.PI) / 180);

/**
 * The scale at which the floor plan fits the canvas. The 3D view turns freely, so it fits the plan's
 * diagonal and stays the same size at every heading; the flat view fits the plan as it is turned.
 */
export function fitScale(canvasW: number, canvasH: number, contentW: number, contentH: number, yawDeg: number, squash: number, freeTurning: boolean): number {
  if (canvasW <= 0 || canvasH <= 0 || contentW <= 0 || contentH <= 0) return 1;
  let extentW: number;
  let extentH: number;
  if (freeTurning) {
    const diagonal = Math.hypot(contentW, contentH);
    extentW = diagonal;
    extentH = diagonal * squash;
  } else {
    const r = (yawDeg * Math.PI) / 180;
    const c = Math.abs(Math.cos(r));
    const s = Math.abs(Math.sin(r));
    extentW = contentW * c + contentH * s;
    extentH = (contentW * s + contentH * c) * squash;
  }
  return Math.min(canvasW / extentW, canvasH / extentH);
}

/**
 * Whether a two-finger movement is a camera tilt: the fingers dragged together, mostly up or down,
 * without pinching or twisting. Anything else is a pinch, a twist or a pan.
 */
export function isTiltDrag(fingers: number, panX: number, panY: number, zoom: number, rotationDeg: number): boolean {
  return fingers >= 2 && Math.abs(zoom - 1) < 0.015 && Math.abs(rotationDeg) < 1.5 && Math.abs(panY) > 2 * Math.abs(panX);
}

/** The flat map's heading after one more quarter turn clockwise. */
export const nextQuarterTurn = (deg: number) => (((Math.round(deg / 90) * 90 + 90) % 360) + 360) % 360;

/** The widest a name may be: the whole view when the room's width is unknown, else its room's, at least minPx. */
export function labelTextWidth(spanKnown: boolean, roomPx: number, minPx: number, viewPx: number): number {
  if (!spanKnown) return viewPx;
  return Math.min(viewPx, Math.max(minPx, Math.trunc(roomPx)));
}

/** How many times larger than the grid the layers are drawn: the biggest side under about 2400 px, 1 to 3. */
export const supersampleFor = (width: number, height: number) => Math.min(3, Math.max(1, Math.floor(2400 / Math.max(width, height, 1))));
