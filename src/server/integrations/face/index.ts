/**
 * Face-recognition provider selection.
 *
 * Callers import `getFaceProvider()` and never a driver, so switching a
 * deployment between no biometrics, the development simulator and AWS
 * Rekognition is an environment change and nothing else.
 *
 * `describeFaceProvider()` is the other half of that, and it exists because
 * `configured` on its own is not enough to render a truthful badge: the mock
 * provider is configured, will answer every call, and performs no recognition at
 * all. Anything drawing that badge must therefore read `isRealRecognition`
 * alongside `configured` -- which is why they travel together in one object
 * rather than being two lookups a screen could do only one of.
 */

import { env } from '@/server/env';
import { AwsRekognitionFaceProvider } from './aws-rekognition';
import { MockFaceRecognitionProvider } from './mock';
import { NotConfiguredFaceRecognitionProvider } from './not-configured';
import type { FaceProviderStatus, FaceRecognitionProvider } from './types';

export type {
  FaceEnrollInput,
  FaceEnrollResult,
  FaceError,
  FaceIdentifiedResult,
  FaceIdentifyInput,
  FaceIdentifyResult,
  FaceLowConfidence,
  FaceMatched,
  FaceMultipleMatches,
  FaceNoMatch,
  FaceNotConfigured,
  FaceNotEnrolled,
  FaceProviderHealth,
  FaceProviderKey,
  FaceProviderStatus,
  FaceRecognitionProvider,
} from './types';
export {
  assertUsableFaceImage,
  isFaceAutoAcceptable,
  isFaceIdentified,
  MAX_FACE_IMAGE_BYTES,
  normalizeImageContentType,
  SUPPORTED_FACE_IMAGE_TYPES,
} from './types';
export { mockFaceControlEnvelope, MOCK_FACE_CONTROL_CONTENT_TYPE } from './mock';
export type { MockFaceDirective } from './mock';

let provider: FaceRecognitionProvider | undefined;

/**
 * Memoised. Not a micro-optimisation: the Rekognition driver latches whether its
 * collection holds any faces so it does not add a DescribeCollection round trip to
 * every unmatched frame, and a fresh instance per attendance scan would throw that
 * away. Freezing the selection is safe because `env` is parsed once at module
 * load -- changing the provider is a deploy, not a runtime toggle.
 */
export function getFaceProvider(): FaceRecognitionProvider {
  provider ??= selectProvider();
  return provider;
}

/**
 * Exhaustive over `FACE_RECOGNITION_PROVIDER` with no `default`, so adding a
 * provider to the enum fails the build here rather than silently falling back to
 * one that does nothing.
 *
 * Construction never reaches the network and never throws: each driver resolves
 * its own configuration on first use, because the settings screen has to be able
 * to render the state of a misconfigured integration instead of 500ing on it.
 */
function selectProvider(): FaceRecognitionProvider {
  switch (env.FACE_RECOGNITION_PROVIDER) {
    case 'aws-rekognition':
      return new AwsRekognitionFaceProvider();
    case 'mock':
      // `env` already refuses this in production.
      return new MockFaceRecognitionProvider();
    case 'none':
      return new NotConfiguredFaceRecognitionProvider();
  }
}

/**
 * Status for the integrations settings page. `health()` is contractually
 * non-throwing, so this resolves even when the provider is unreachable -- a red
 * badge tells an administrator more than a failed page does.
 */
export async function describeFaceProvider(): Promise<FaceProviderStatus> {
  const selected = getFaceProvider();
  const health = await selected.health();
  return {
    key: selected.key,
    isRealRecognition: selected.isRealRecognition,
    configured: health.configured,
    message: health.message,
  };
}

/**
 * Drop the memoised provider. For tests that change `env` between cases; a
 * request handler must never call it, because it would discard the Rekognition
 * driver's collection latch mid-run.
 */
export function __resetFaceProvider(): void {
  provider = undefined;
}
