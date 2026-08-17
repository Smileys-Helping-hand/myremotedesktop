import { CoordinateTranslationResult, HostScreenMetadata } from '../types/remoteControl';

/**
 * ============================================================================
 * COORDINATE NORMALIZATION & TRANSLATION ENGINE (THE HARD PROBLEM)
 * ============================================================================
 * 
 * Problem Statement:
 * When streaming a remote screen over WebRTC, the Host monitor resolution (e.g. 4K 3840x2160)
 * rarely matches the Client browser window (e.g. 1080p laptop). The `<video>` element uses
 * CSS `object-fit: contain`, which renders black bars (letterboxing on top/bottom or pillarboxing
 * on left/right) to preserve the source aspect ratio.
 * 
 * Furthermore, high-DPI scaling (Retina / Windows scaling factor) creates a discrepancy
 * between physical screen pixels and logical OS desktop coordinates.
 * 
 * This engine mathematically computes:
 * 1. The exact rendered video bounding box inside the `<video>` container.
 * 2. Whether the pointer is inside or on the black letterbox bars.
 * 3. Unit-normalized coordinates (u, v) ∈ [0.0, 1.0].
 * 4. Absolute physical and logical pixels on the Host's target display.
 */

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Computes the rendered video content sub-rectangle within a container element
 * using the standard CSS `object-fit: contain` layout algorithm.
 * 
 * @param containerWidth  The actual CSS pixel width of the <video> element
 * @param containerHeight The actual CSS pixel height of the <video> element
 * @param sourceWidth     The native width of the video stream (Host resolution)
 * @param sourceHeight    The native height of the video stream (Host resolution)
 */
export function getContainedVideoRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number
): {
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  isPillarboxed: boolean;
  isLetterboxed: boolean;
} {
  if (containerWidth <= 0 || containerHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      renderedWidth: 0,
      renderedHeight: 0,
      offsetX: 0,
      offsetY: 0,
      isPillarboxed: false,
      isLetterboxed: false,
    };
  }

  // Calculate Aspect Ratios
  const containerAspect = containerWidth / containerHeight;
  const sourceAspect = sourceWidth / sourceHeight;

  let renderedWidth = 0;
  let renderedHeight = 0;
  let offsetX = 0;
  let offsetY = 0;
  let isPillarboxed = false;
  let isLetterboxed = false;

  // Comparison tolerance for floating point
  const EPSILON = 0.0001;

  if (containerAspect > sourceAspect + EPSILON) {
    // Container is WIDER than source aspect ratio -> PILLARBOXING (black bars on Left & Right)
    // The video height matches the container height; width is scaled down.
    renderedHeight = containerHeight;
    renderedWidth = containerHeight * sourceAspect;
    offsetX = (containerWidth - renderedWidth) / 2;
    offsetY = 0;
    isPillarboxed = true;
  } else if (containerAspect < sourceAspect - EPSILON) {
    // Container is TALLER than source aspect ratio -> LETTERBOXING (black bars on Top & Bottom)
    // The video width matches the container width; height is scaled down.
    renderedWidth = containerWidth;
    renderedHeight = containerWidth / sourceAspect;
    offsetX = 0;
    offsetY = (containerHeight - renderedHeight) / 2;
    isLetterboxed = true;
  } else {
    // Exact match: Video fills container perfectly without black bars
    renderedWidth = containerWidth;
    renderedHeight = containerHeight;
    offsetX = 0;
    offsetY = 0;
  }

  return {
    renderedWidth,
    renderedHeight,
    offsetX,
    offsetY,
    isPillarboxed,
    isLetterboxed,
  };
}

/**
 * Translates a client pointer event on a `<video>` element into absolute Host coordinates.
 * 
 * @param clientX      Pointer event clientX (relative to viewport)
 * @param clientY      Pointer event clientY (relative to viewport)
 * @param videoElement The HTMLVideoElement or HTMLElement container bounding rect
 * @param hostMetadata Host screen physical width, height, and devicePixelRatio
 */
export function calculateRemoteCoordinates(
  clientX: number,
  clientY: number,
  videoRect: BoundingBox,
  hostMetadata: HostScreenMetadata
): CoordinateTranslationResult {
  const { width: containerWidth, height: containerHeight, left: containerLeft, top: containerTop } = videoRect;
  const hostWidth = hostMetadata.width;
  const hostHeight = hostMetadata.height;
  const hostDPR = hostMetadata.devicePixelRatio || 1.0;

  // 1. Convert viewport coordinates to container-relative coordinates
  const pointerInsideContainerX = clientX - containerLeft;
  const pointerInsideContainerY = clientY - containerTop;

  // 2. Compute the CSS `object-fit: contain` rendered video dimensions and offset
  const {
    renderedWidth,
    renderedHeight,
    offsetX,
    offsetY,
    isPillarboxed,
    isLetterboxed,
  } = getContainedVideoRect(containerWidth, containerHeight, hostWidth, hostHeight);

  // 3. Subtract letterbox/pillarbox offset to get coordinates relative to active video stream
  const videoRelativeX = pointerInsideContainerX - offsetX;
  const videoRelativeY = pointerInsideContainerY - offsetY;

  // 4. Check whether click occurred within active video area or on the black letterbox borders
  const isOutOfBounds =
    videoRelativeX < 0 ||
    videoRelativeX > renderedWidth ||
    videoRelativeY < 0 ||
    videoRelativeY > renderedHeight;

  // 5. Clamp to [0, renderedWidth] and [0, renderedHeight] to avoid runaway values during drag/drop
  const clampedX = Math.max(0, Math.min(renderedWidth, videoRelativeX));
  const clampedY = Math.max(0, Math.min(renderedHeight, videoRelativeY));

  // 6. Calculate Normalized Unit Coordinates (u, v) ∈ [0.0, 1.0]
  // This dimensionless representation is network-efficient and resolution-agnostic.
  const normalizedX = renderedWidth > 0 ? clampedX / renderedWidth : 0;
  const normalizedY = renderedHeight > 0 ? clampedY / renderedHeight : 0;

  // 7. Project onto Host Physical Monitor Pixels
  const hostPhysicalX = Math.round(normalizedX * hostWidth);
  const hostPhysicalY = Math.round(normalizedY * hostHeight);

  // 8. Project onto Host Logical Points (Required by OS automation libraries like nut.js on macOS/Windows)
  // On macOS with Retina display (DPR = 2.0), mouse coords are measured in logical points (width / 2.0).
  const hostLogicalX = Math.round(hostPhysicalX / hostDPR);
  const hostLogicalY = Math.round(hostPhysicalY / hostDPR);

  return {
    elementWidth: containerWidth,
    elementHeight: containerHeight,
    renderedWidth,
    renderedHeight,
    offsetX,
    offsetY,
    isPillarboxed,
    isLetterboxed,
    normalizedX: parseFloat(normalizedX.toFixed(6)),
    normalizedY: parseFloat(normalizedY.toFixed(6)),
    isOutOfBounds,
    hostPhysicalX,
    hostPhysicalY,
    hostLogicalX,
    hostLogicalY,
  };
}

/**
 * Denormalizes (u, v) coordinates back to Host physical or logical pixels.
 * Used on the Host Electron main process when reading packets from WebRTC RTCDataChannel.
 */
export function denormalizeHostCoordinates(
  normX: number,
  normY: number,
  hostMetadata: HostScreenMetadata,
  mode: 'physical' | 'logical' = 'logical'
): { x: number; y: number } {
  // Clamp input [0.0, 1.0]
  const clampedNormX = Math.max(0, Math.min(1, normX));
  const clampedNormY = Math.max(0, Math.min(1, normY));

  const physicalX = Math.round(clampedNormX * hostMetadata.width);
  const physicalY = Math.round(clampedNormY * hostMetadata.height);

  if (mode === 'physical') {
    return { x: physicalX, y: physicalY };
  }

  const dpr = hostMetadata.devicePixelRatio || 1.0;
  return {
    x: Math.round(physicalX / dpr),
    y: Math.round(physicalY / dpr),
  };
}
