/**
 * The face lane's one HTTP surface.
 *
 * Deliberately one route. The phone does detection, tracking, landmarks and
 * the active-speaker correlation locally, and uploads a crop per track per
 * second; everything the server has to decide about a face it decides here.
 */

import type { Hono } from 'hono'
import type { FaceObservationRequest, ServerDependencies } from '../../shared/contracts'
import { faceServiceFor, type FaceService } from './service'

export { createFaceService, faceServiceFor, type FaceEmbedder, type FaceService } from './service'
export { createPresenceTracker, presenceTrackerFor, registerPresence, type PresenceTracker } from './presence'
export { FaceTrackLedger, type Span, type TrackObservation, type TrackState } from './tracks'
export { decideFace, scoreFaces, selectWeakestFaceprints } from './matcher'

export function registerFaceRoutes(app: Hono, deps: ServerDependencies): void {
  let servicePromise: Promise<FaceService> | undefined

  const getService = async (): Promise<FaceService> => {
    servicePromise ??= faceServiceFor(deps)
    try {
      return await servicePromise
    } catch (error) {
      servicePromise = undefined
      throw error
    }
  }

  app.post('/faces/observe', async (context) => {
    const request = await context.req.json<FaceObservationRequest>()
    if (!request?.track_id || !request.crop_jpeg_base64) {
      return context.json({ error: 'track_id and crop_jpeg_base64 are required' }, 400)
    }
    // A face lane that cannot reach storage is not a failed recording. Say so
    // and let the phone carry on; voice identity does not depend on this.
    let service: FaceService
    try {
      service = await getService()
    } catch (error) {
      console.warn('[faces] service unavailable', error)
      return context.json({ error: 'face matching unavailable' }, 503)
    }
    return context.json(await service.observe(request))
  })
}
