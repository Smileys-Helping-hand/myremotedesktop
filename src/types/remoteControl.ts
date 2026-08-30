export interface HostScreenMetadata {
  width: number;             // Physical width in pixels (e.g., 3840, 2560, 1920)
  height: number;            // Physical height in pixels (e.g., 2160, 1440, 1080)
  devicePixelRatio: number;  // Host OS scale factor (e.g., 1.0, 1.25, 1.5, 2.0)
  displayId?: string;        // Host display identifier, e.g. "display-0"
}

export interface ClientVideoRect {
  elementWidth: number;      // CSS rendered width of <video> container
  elementHeight: number;     // CSS rendered height of <video> container
  videoSourceWidth: number;  // VideoTrack intrinsic width
  videoSourceHeight: number; // VideoTrack intrinsic height
}

export interface CoordinateTranslationResult {
  // Client Video Dimensions
  elementWidth: number;
  elementHeight: number;
  // Computed Rendered Video sub-rectangle inside the letterboxed element
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  isPillarboxed: boolean;
  isLetterboxed: boolean;

  // Relative to Rendered Video [0..1]
  normalizedX: number;
  normalizedY: number;
  isOutOfBounds: boolean;

  // Absolute Target Coordinates on Host Machine
  hostPhysicalX: number;
  hostPhysicalY: number;
  // Scaled coordinates for OS injection APIs that target logical points
  hostLogicalX: number;
  hostLogicalY: number;
}

export type RemoteMouseButton = 'left' | 'middle' | 'right';

export interface RemoteMouseMovePayload {
  type: 'MOUSE_MOVE';
  normX: number; // Normalized 0..1
  normY: number; // Normalized 0..1
  timestamp: number;
}

export interface RemoteMouseButtonPayload {
  type: 'MOUSE_DOWN' | 'MOUSE_UP';
  button: RemoteMouseButton;
  normX: number;
  normY: number;
  clicks?: number; // 1 = single, 2 = double
  timestamp: number;
}

export interface RemoteMouseWheelPayload {
  type: 'MOUSE_WHEEL';
  deltaX: number;
  deltaY: number;
  timestamp: number;
}

export interface RemoteKeyboardPayload {
  type: 'KEY_DOWN' | 'KEY_UP';
  key: string;      // standard KeyboardEvent.key
  code: string;     // standard KeyboardEvent.code (e.g. 'KeyA', 'Enter')
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  timestamp: number;
}

export interface PermissionRequestPayload {
  type: 'PERMISSION_REQUEST';
  clientId: string;
  clientName: string;
}

export interface PermissionResponsePayload {
  type: 'PERMISSION_RESPONSE';
  granted: boolean;
  reason?: string;
}

export interface KillSwitchPayload {
  type: 'KILL_SWITCH_ACTIVE';
  suspendedUntil: number;
}

export interface ClipboardUpdatePayload {
  type: 'CLIPBOARD_UPDATE';
  text: string;
  timestamp: number;
  sourceId: string;
}

export interface FileTransferStartPayload {
  type: 'FILE_TRANSFER_START';
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  checksum?: string;
  timestamp: number;
}

export interface FileTransferChunkPayload {
  type: 'FILE_TRANSFER_CHUNK';
  transferId: string;
  chunkIndex: number;
  data: string; // Base64 chunk or binary payload
  timestamp: number;
}

export interface FileTransferCompletePayload {
  type: 'FILE_TRANSFER_COMPLETE';
  transferId: string;
  fileName: string;
  fileSize: number;
  timestamp: number;
}

export interface FileTransferCancelPayload {
  type: 'FILE_TRANSFER_CANCEL';
  transferId: string;
  reason?: string;
  timestamp: number;
}

export interface AnnotationStroke {
  id: string;
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

export interface WebRTCStats {
  roundTripTimeMs?: number;
  rttMs?: number;
  fps: number;
  bitrateKbps: number;
  jitterMs?: number;
  packetsSent: number;
  packetsReceived: number;
  resolution?: { width: number; height: number };
}

export interface AnnotationPoint {
  x: number; // Normalized 0..1
  y: number; // Normalized 0..1
  time: number;
}

export interface AnnotationStrokePayload {
  type: 'ANNOTATION_STROKE';
  strokeId: string;
  points: AnnotationPoint[];
  color: string;
  width: number;
  mode: 'pen' | 'laser' | 'clear';
  timestamp: number;
}

export interface HostUACStatusPayload {
  type: 'HOST_UAC_PAUSED';
  isPaused: boolean;
  timestamp: number;
}

export interface PanicSeverPayload {
  type: 'PANIC_SEVER_CONNECTION';
  reason: string;
  timestamp: number;
}

export interface PinAuthRequestPayload {
  type: 'PIN_AUTH_REQUEST';
  sessionId: string;
  enteredPin: string;
  timestamp: number;
}

export interface PinAuthResponsePayload {
  type: 'PIN_AUTH_RESPONSE';
  success: boolean;
  reason?: string;
  timestamp: number;
}

export interface StreamQualityProfile {
  id: 'performance' | 'clarity' | 'bandwidth';
  label: string;
  resolution: { width: number; height: number };
  targetFps: number;
  maxBitrateKbps: number;
  contentHint: 'motion' | 'detail' | 'text';
  description: string;
}

export type RemoteControlPacket =
  | RemoteMouseMovePayload
  | RemoteMouseButtonPayload
  | RemoteMouseWheelPayload
  | RemoteKeyboardPayload
  | PermissionRequestPayload
  | PermissionResponsePayload
  | KillSwitchPayload
  | ClipboardUpdatePayload
  | FileTransferStartPayload
  | FileTransferChunkPayload
  | FileTransferCompletePayload
  | FileTransferCancelPayload
  | AnnotationStrokePayload
  | HostUACStatusPayload
  | PanicSeverPayload
  | PinAuthRequestPayload
  | PinAuthResponsePayload;

export interface SignalingMessage {
  type: 'join' | 'offer' | 'answer' | 'ice-candidate' | 'leave' | 'peer-joined' | 'peer-left' | 'pin-auth';
  roomId: string;
  senderId: string;
  targetId?: string;
  pin?: string;
  data?: any;
}

/**
 * Kill-switch tuning, mirrored from `src-tauri/src/input.rs`.
 *
 * The Rust host is authoritative — these constants exist so the UI describes
 * the real behaviour instead of hardcoding numbers that quietly drift from it.
 * Change them here and in `input.rs` together.
 */
export const KILL_SWITCH_COOLDOWN_MS = 2_500;
export const PHYSICAL_MOVEMENT_THRESHOLD_PX = 12;
