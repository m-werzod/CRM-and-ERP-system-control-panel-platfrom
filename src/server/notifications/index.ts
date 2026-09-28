/**
 * The notification engine's public surface.
 *
 * Business code imports exactly two things from here: `notify()` to ask for a
 * message, and the event catalogue to know what an event needs. `renderAndDeliver`
 * is for the job handler that drains the outbox, and the template set is for
 * `prisma/seed` and the settings screens.
 *
 * Nothing below reaches for a provider. Which gateway sends an SMS is
 * `@/server/integrations/messaging`'s question, and it is asked once, inside
 * ./dispatch.ts, after the transaction that queued the row has committed.
 */

// --- asking for a message ---------------------------------------------------
export { notify } from './enqueue';
export type { NotifyInput, NotifyResult } from './enqueue';

// --- the event contract -----------------------------------------------------
export {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_KEYS,
  eventDefinition,
  eventVariableNames,
  parseEventVariables,
} from './events';
export type {
  Audience,
  EventDefinition,
  EventVariables,
  GuardianGate,
  NotificationEventCatalogue,
  SubjectRequirement,
} from './events';

// --- recipients -------------------------------------------------------------
export {
  channelAddress,
  loadPreferences,
  maskAddress,
  pointerFor,
  resolveRecipients,
  UNADDRESSABLE_CHANNELS,
} from './recipients';
export type {
  PreferenceLookup,
  RecipientPointer,
  RecipientSelector,
  ResolvedRecipient,
} from './recipients';

// --- templates --------------------------------------------------------------
export {
  DEFAULT_NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_COPY,
  SEEDED_TEMPLATE_CHANNELS,
  TEMPLATE_LOCALES,
  findDefaultTemplate,
} from './templates';
export type { NotificationTemplateSeed } from './templates';

// --- the renderer (settings UI validates a draft before saving it) ----------
export { escapeHtml, extractVariables, renderTemplate, validateTemplate } from './template';
export type {
  EscapeMode,
  RenderOptions,
  RenderResult,
  TemplateContext,
  TemplateObject,
  TemplateValidation,
  TemplateValue,
} from './template';

// --- delivery (the job handlers' entry points) ------------------------------
export {
  dispatchPendingBatch,
  IN_APP_PROVIDER_KEY,
  IntegrationRetryError,
  renderAndDeliver,
} from './dispatch';
export type { BatchDispatchInput, DeliveryEnvelope, DeliveryOutcome } from './dispatch';
