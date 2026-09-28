/**
 * The default face-recognition provider: none.
 *
 * `FACE_RECOGNITION_PROVIDER=none` is the shipped default, so this is what most
 * deployments actually run. It exists to make "we do not do biometrics here" a
 * working, first-class configuration rather than a broken one.
 *
 * The three methods answer differently on purpose:
 *
 * - `identify` RETURNS `NOT_CONFIGURED`. It sits behind a device endpoint that is
 *   polled continuously; a throw there would turn a deliberate configuration into
 *   a stream of 503s and an alert page. The caller records the outcome as a
 *   `FaceRecognitionEvent` like any other and the terminal shows "not set up".
 *
 * - `enroll` THROWS. There is no `externalRef` to invent, and returning a fake one
 *   would put a dangling reference in `BiometricEnrollment` that a later real
 *   provider would be asked to interpret.
 *
 * - `deleteEnrollment` THROWS, which is the non-obvious one. Resolving quietly
 *   would be far more convenient: the caller would drop its row and move on. But
 *   nothing would have contacted a provider, so the application would be telling
 *   a person their biometric template was deleted when it has no idea whether it
 *   was. In a privacy feature that is the worst available outcome, so the
 *   operator is made to switch the provider back on to complete the deletion.
 */

import { IntegrationNotConfiguredError } from '@/server/errors';
import type {
  FaceEnrollResult,
  FaceIdentifyResult,
  FaceProviderHealth,
  FaceRecognitionProvider,
} from './types';

const INTEGRATION = 'Face recognition';

const REASON =
  'No face-recognition provider is selected (FACE_RECOGNITION_PROVIDER=none).';

export class NotConfiguredFaceRecognitionProvider implements FaceRecognitionProvider {
  readonly key = 'none' as const;
  readonly isRealRecognition = false;

  async health(): Promise<FaceProviderHealth> {
    return {
      configured: false,
      message:
        'Face recognition is switched off. Set FACE_RECOGNITION_PROVIDER to a provider and supply its credentials to enable it.',
    };
  }

  async enroll(): Promise<FaceEnrollResult> {
    throw new IntegrationNotConfiguredError(
      INTEGRATION,
      `${REASON} A face cannot be enrolled until one is configured.`,
    );
  }

  async identify(): Promise<FaceIdentifyResult> {
    return { result: 'NOT_CONFIGURED', reason: REASON };
  }

  async deleteEnrollment(): Promise<void> {
    throw new IntegrationNotConfiguredError(
      INTEGRATION,
      `${REASON} The stored reference cannot be deleted at the provider until the provider it was created with is configured again, and this application will not report a deletion it did not perform.`,
    );
  }
}
