/**
 * What the glasses are doing, for the status chip and the dev sheet.
 *
 * Everything here is the newest value rather than a log. The board sends a
 * status every second and frames several times a second, and keeping a history
 * of that in the store would grow without bound to render one line of text.
 * `lastFrame` in particular is replaced, never appended: it holds a JPEG.
 */

import type {
  CaptureMode,
  FaceObservationResponse,
  GlassesStatus,
  Id,
  OwnerCheckResponse,
} from '../../../shared/contracts';
import type { GlassesLinkStatus } from '../../glasses/glasses-link';
import type { GlassesSessionState } from '../../glasses/glasses-session';
import type { BoundingBox } from '../../glasses/vision';

export interface GlassesTrackView {
  track_id: Id;
  bbox: BoundingBox;
  is_near: boolean;
  mouth_openness?: number;
  speaking_score?: number;
  is_active_speaker: boolean;
}

export interface GlassesFrameView {
  ts_ms: number;
  width: number;
  height: number;
  /** Absent until the dev sheet is open: a base64 frame is not free to keep. */
  jpeg_base64?: string;
  tracks: GlassesTrackView[];
}

export interface GlassesState {
  link: GlassesLinkStatus;
  session: GlassesSessionState;
  mode: CaptureMode;
  pinned: boolean;
  conversationActive: boolean;
  conversationId?: Id;
  lastStatus?: GlassesStatus;
  kbps: number;
  prerollFillMs: number;
  lastFrame?: GlassesFrameView;
  lastOwnerCheck?: OwnerCheckResponse;
  lastObservation?: FaceObservationResponse;
}

export const initialGlassesState: GlassesState = {
  link: 'disconnected',
  session: 'disconnected',
  mode: 'group',
  pinned: false,
  conversationActive: false,
  kbps: 0,
  prerollFillMs: 0,
};

export type GlassesUiEvent =
  | { type: 'glasses-link'; status: GlassesLinkStatus }
  | { type: 'glasses-status'; status: GlassesStatus; kbps?: number }
  | { type: 'glasses-mode'; mode: CaptureMode; pinned: boolean }
  | { type: 'glasses-session'; state: GlassesSessionState; conversationId?: Id }
  | { type: 'glasses-frame'; frame: GlassesFrameView; prerollFillMs?: number }
  | { type: 'glasses-owner-check'; result: OwnerCheckResponse }
  | { type: 'glasses-observation'; response: FaceObservationResponse };

function onLink(state: GlassesState, status: GlassesLinkStatus): GlassesState {
  if (status === 'connected') return { ...state, link: status };
  // Nothing observed about a board we cannot reach is still true.
  return {
    ...initialGlassesState,
    link: status,
    mode: state.mode,
    pinned: state.pinned,
  };
}

export function glassesReducer(state: GlassesState, event: GlassesUiEvent): GlassesState {
  switch (event.type) {
    case 'glasses-link':
      return onLink(state, event.status);
    case 'glasses-status':
      return { ...state, lastStatus: event.status, kbps: event.kbps ?? state.kbps };
    case 'glasses-mode':
      return { ...state, mode: event.mode, pinned: event.pinned };
    case 'glasses-session':
      return {
        ...state,
        session: event.state,
        conversationActive: event.state === 'recording',
        conversationId: event.state === 'recording' ? event.conversationId : undefined,
      };
    case 'glasses-frame':
      return { ...state, lastFrame: event.frame, prerollFillMs: event.prerollFillMs ?? state.prerollFillMs };
    case 'glasses-owner-check':
      return { ...state, lastOwnerCheck: event.result };
    case 'glasses-observation':
      return { ...state, lastObservation: event.response };
    default:
      return state;
  }
}
