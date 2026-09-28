/**
 * SMS specifics shared by the Uzbek gateways and Twilio.
 *
 * Phone numbers reach a provider as E.164 (`+998901234512`) because that is what
 * `normalizePhone` in `@/lib/validation` produces and what the database stores.
 * Two of the three gateways reject the leading `+`, so the conversion happens
 * once, here, rather than being remembered in each driver.
 */

/** Digits only, no `+`, no spaces -- the MSISDN form Eskiz and Play Mobile want. */
export function toMsisdn(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * The GSM 03.38 alphabet. A message drawn entirely from it is billed in 7-bit
 * septets; one character outside it forces the whole message to UCS-2, which is
 * why a single Cyrillic or Uzbek Latin diacritic more than halves the capacity.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Reachable only through an escape, so each of these costs two septets. */
const GSM_EXTENDED = '^{}\\[~]|€';

const GSM_SINGLE_LIMIT = 160;
const GSM_CONCATENATED_LIMIT = 153;
const UCS2_SINGLE_LIMIT = 70;
const UCS2_CONCATENATED_LIMIT = 67;

/**
 * An estimate for the log and for a pre-send cost warning, not a bill. Twilio
 * reports the real segment count and overwrites this; the Uzbek gateways report
 * nothing, so an estimate is the only figure available to explain to an
 * administrator why a 200-character reminder cost two messages.
 */
export function estimateSmsSegments(text: string): number {
  let septets = 0;
  let gsm = true;

  for (const char of text) {
    if (GSM_BASIC.includes(char)) {
      septets += 1;
      continue;
    }
    if (GSM_EXTENDED.includes(char)) {
      septets += 2;
      continue;
    }
    gsm = false;
    break;
  }

  if (gsm) {
    if (septets <= GSM_SINGLE_LIMIT) return 1;
    return Math.ceil(septets / GSM_CONCATENATED_LIMIT);
  }

  // UTF-16 code units: a surrogate pair already counts as the two units it
  // occupies on the wire.
  const units = text.length;
  if (units <= UCS2_SINGLE_LIMIT) return 1;
  return Math.ceil(units / UCS2_CONCATENATED_LIMIT);
}
