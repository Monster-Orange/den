/** A mask: a rectangle in fractions of the image (0..1). */
export interface Mask {
  x: number;
  y: number;
  w: number;
  h: number;
}
export declare function configureShots(o?: { library?: string }): void;
/** The page as the person sees it, or null (never throws). */
export declare function capture(o?: {
  seconds?: number;
  skip?: (node: Node) => boolean;
}): Promise<HTMLCanvasElement | null>;
export declare function masked(
  canvas: HTMLCanvasElement,
  masks: Mask[],
): HTMLCanvasElement;
export declare function rectOf(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Mask;
export declare function rectOfPercent(
  x: number,
  y: number,
  w: number,
  h: number,
): Mask;
export declare function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null>;
export declare function canvasOf(
  src: string | Blob,
): Promise<HTMLCanvasElement | null>;
export declare function keepShot(
  id: string,
  canvas: HTMLCanvasElement | null,
  masks: Mask[],
  noShot: boolean,
): Promise<boolean>;
export declare function loadShot(id: string): Promise<{
  canvas: HTMLCanvasElement | null;
  masks: Mask[];
  noShot: boolean;
} | null>;
export declare function dropShot(id: string): Promise<void>;
