/**
 * The notification template renderer.
 *
 * A NotificationTemplate body is OPERATOR-AUTHORED CONTENT. A receptionist with
 * `notifications.manageTemplates` can edit it from the settings UI, and that text
 * then runs on the server for every recipient of the event. It must therefore
 * never become a code-execution path: there is no `eval`, no `new Function`, no
 * expression parser, no helper that takes arguments, and no way to reach a
 * property that was not explicitly placed in the render context. The grammar is
 * deliberately three constructs wide -- interpolation, dotted lookup, and a
 * presence test -- because every construct beyond that is a place where "render
 * a message" turns into "run whatever the template says".
 *
 * The grammar:
 *
 *     {{studentName}}          interpolate
 *     {{invoice.number}}       interpolate a dotted path
 *     {{#if balance}}...{{/if}} render the block when the value is present
 *
 * There is no triple-stache. Mustache's `{{{raw}}}` exists to bypass escaping,
 * which is exactly the hole an operator-editable template must not have.
 *
 * Rendering NEVER throws. It runs inside the business transaction that enqueues a
 * notification (see ./enqueue.ts), so a stray `{{#if` left in a template by an
 * operator must not be able to roll back the attendance submission or the payment
 * that triggered the message. Structural problems come back in `syntaxErrors` and
 * the renderer degrades to the most useful output it can produce.
 */

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type TemplateValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined
  | TemplateObject
  | readonly TemplateValue[];

export interface TemplateObject {
  readonly [key: string]: TemplateValue;
}

/** The variables a template may reference. Nothing outside it is reachable. */
export type TemplateContext = TemplateObject;

export type EscapeMode = 'none' | 'html';

export interface RenderOptions {
  /**
   * `none` for SMS and plain-text bodies, `html` for the HTML part of an email.
   *
   * The distinction matters in both directions. HTML-escaping an SMS would put
   * literal `&amp;` and `&#39;` on a phone screen and lengthen the message --
   * SMS is billed per 160-character segment (70 for Cyrillic), so a wrong escape
   * is both ugly and a line item on the invoice. Not escaping HTML would let a
   * value that came from user data -- a student's name, a guardian's note, a
   * cancellation reason -- close the surrounding tag and inject markup into
   * every parent's inbox.
   */
  readonly escape?: EscapeMode;
}

export interface RenderResult {
  readonly text: string;
  /**
   * Paths that were interpolated but had no value in the context. Reported
   * rather than rendered, because a template with a typo in it must be visible
   * to the operator who wrote it: silently emitting "undefined" -- or worse, an
   * empty string -- turns a one-character mistake into months of blank messages
   * nobody can explain.
   */
  readonly missingVariables: readonly string[];
  /**
   * Structural problems in the template itself: an unclosed block, an unknown
   * `{{#helper}}`, a path that resolved to an object. Separate from
   * `missingVariables` because these are bugs in the template, not gaps in the
   * data.
   */
  readonly syntaxErrors: readonly string[];
}

// ---------------------------------------------------------------------------
// Limits
//
// A template is stored in a database column an operator can fill, and a render
// happens once per recipient. Both ends need a ceiling.
// ---------------------------------------------------------------------------

const MAX_SOURCE_LENGTH = 20_000;
const MAX_OUTPUT_LENGTH = 20_000;
const MAX_BLOCK_DEPTH = 8;
const MAX_PATH_SEGMENTS = 6;

/** Path segments must look like identifiers, which rules out the prototype chain. */
const SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that must never resolve even if a caller puts them in the context. An
 * operator typing `{{constructor.constructor}}` gets a missing variable, not a
 * function.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/**
 * Escapes the five characters that can break out of HTML text or an attribute
 * value. Applied to SUBSTITUTED VALUES ONLY -- the template's own literal text is
 * emitted verbatim, because an operator writing an email body legitimately types
 * `<p>` and `<br>` and expects them to be markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES.get(character) ?? character);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Node =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'var'; readonly path: string }
  | { readonly kind: 'if'; readonly path: string; readonly children: Node[] };

interface ParseResult {
  readonly nodes: readonly Node[];
  readonly errors: readonly string[];
}

/** `{{ ... }}` with no brace inside, so a stray `{{` cannot swallow the rest. */
const TAG_PATTERN = /\{\{([^{}]*)\}\}/g;

function parse(source: string): ParseResult {
  const errors: string[] = [];
  const root: Node[] = [];
  /** Innermost open block last; `root` is the floor and is never popped. */
  const stack: { readonly path: string; readonly children: Node[] }[] = [];
  const currentChildren = (): Node[] => stack[stack.length - 1]?.children ?? root;

  let cursor = 0;
  TAG_PATTERN.lastIndex = 0;
  let match = TAG_PATTERN.exec(source);

  while (match) {
    if (match.index > cursor) {
      currentChildren().push({ kind: 'text', value: source.slice(cursor, match.index) });
    }
    cursor = match.index + match[0].length;

    const inner = (match[1] ?? '').trim();
    const openBlock = /^#if\s+(\S+)$/.exec(inner);
    const closeBlock = inner === '/if';

    if (openBlock) {
      const path = openBlock[1] ?? '';
      if (stack.length >= MAX_BLOCK_DEPTH) {
        errors.push(`Conditional blocks are nested more than ${MAX_BLOCK_DEPTH} deep.`);
      } else {
        stack.push({ path, children: [] });
      }
    } else if (closeBlock) {
      const open = stack.pop();
      if (!open) {
        errors.push('Found {{/if}} with no matching {{#if}}.');
      } else {
        currentChildren().push({ kind: 'if', path: open.path, children: open.children });
      }
    } else if (inner.startsWith('#') || inner.startsWith('/') || inner.startsWith('^')) {
      // An unknown block helper. Kept as literal text rather than guessed at:
      // inventing behaviour for `{{#each}}` would be a silent feature.
      errors.push(`Unsupported block "${inner}". Only {{#if variable}}...{{/if}} is available.`);
      currentChildren().push({ kind: 'text', value: match[0] });
    } else if (inner.length === 0) {
      errors.push('Found an empty {{}} placeholder.');
    } else {
      currentChildren().push({ kind: 'var', path: inner });
    }

    match = TAG_PATTERN.exec(source);
  }

  if (cursor < source.length) {
    currentChildren().push({ kind: 'text', value: source.slice(cursor) });
  }

  // Close anything the operator forgot to close, so the block's contents still
  // reach the recipient instead of vanishing.
  while (stack.length > 0) {
    const open = stack.pop();
    if (!open) break;
    errors.push(`{{#if ${open.path}}} was never closed with {{/if}}.`);
    currentChildren().push({ kind: 'if', path: open.path, children: open.children });
  }

  return { nodes: root, errors };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const MISSING = Symbol('missing');

function lookup(context: TemplateContext, path: string): TemplateValue | typeof MISSING {
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) return MISSING;

  let current: TemplateValue = context;
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment) || FORBIDDEN_SEGMENTS.has(segment)) return MISSING;
    if (current === null || current === undefined || typeof current !== 'object') return MISSING;
    if (current instanceof Date || Array.isArray(current)) return MISSING;
    // `hasOwn` rather than `in`: an inherited property is not context data.
    if (!Object.hasOwn(current, segment)) return MISSING;
    current = (current as TemplateObject)[segment];
  }
  return current;
}

/** How a resolved value becomes message text. */
function stringify(value: Exclude<TemplateValue, undefined | null>): string | null {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? String(value) : null;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      // A raw minor-unit amount is never what a reader wants. Money must arrive
      // pre-formatted by the call site via formatMoney(); this is the fallback
      // that keeps a mistake legible instead of printing 45000000.
      return value.toString();
    default:
      break;
  }
  if (value instanceof Date) {
    // Likewise: a calendar date belongs to the caller's timezone, not to the
    // renderer, so call sites format with @/lib/dates before handing it over.
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (item === null || item === undefined) continue;
      const rendered = stringify(item);
      if (rendered !== null) parts.push(rendered);
    }
    return parts.join(', ');
  }
  // A plain object: the template asked for a branch of the context, not a leaf.
  return null;
}

/**
 * Presence test for `{{#if}}`. Empty string, zero, an empty array and
 * whitespace-only text are all false, because an operator writing
 * `{{#if unpaidCount}}` means "when there is something unpaid", not "when the
 * key exists".
 */
function isTruthy(value: TemplateValue | typeof MISSING): boolean {
  if (value === MISSING || value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return value !== 0 && Number.isFinite(value);
  if (typeof value === 'bigint') return value !== 0n;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render `source` against `context`.
 *
 * Never throws. An unresolved interpolation contributes an empty string and its
 * path to `missingVariables`.
 */
export function renderTemplate(
  source: string,
  context: TemplateContext,
  options: RenderOptions = {},
): RenderResult {
  const escape = options.escape ?? 'none';
  const syntaxErrors: string[] = [];
  const missing = new Set<string>();

  let body = source;
  if (body.length > MAX_SOURCE_LENGTH) {
    syntaxErrors.push(`Template is longer than ${MAX_SOURCE_LENGTH} characters and was truncated.`);
    body = body.slice(0, MAX_SOURCE_LENGTH);
  }

  const parsed = parse(body);
  syntaxErrors.push(...parsed.errors);

  const out: string[] = [];
  let length = 0;
  let truncated = false;

  const push = (text: string): void => {
    if (truncated || text.length === 0) return;
    if (length + text.length > MAX_OUTPUT_LENGTH) {
      out.push(text.slice(0, MAX_OUTPUT_LENGTH - length));
      truncated = true;
      return;
    }
    out.push(text);
    length += text.length;
  };

  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (truncated) return;
      switch (node.kind) {
        case 'text':
          push(node.value);
          break;
        case 'if':
          // An unresolved path inside {{#if}} is NOT a missing variable: a
          // conditional exists precisely to handle a value that may be absent.
          // Typos in a conditional are caught by validateTemplate() at save
          // time, against the template's declared `variables`.
          if (isTruthy(lookup(context, node.path))) walk(node.children);
          break;
        case 'var': {
          const value = lookup(context, node.path);
          if (value === MISSING || value === null || value === undefined) {
            missing.add(node.path);
            break;
          }
          const rendered = stringify(value);
          if (rendered === null) {
            syntaxErrors.push(
              `{{${node.path}}} is not a single value, so nothing was inserted for it.`,
            );
            break;
          }
          push(escape === 'html' ? escapeHtml(rendered) : rendered);
          break;
        }
      }
    }
  };

  walk(parsed.nodes);

  if (truncated) {
    syntaxErrors.push(`Rendered message exceeded ${MAX_OUTPUT_LENGTH} characters and was cut off.`);
  }

  return {
    text: out.join(''),
    missingVariables: [...missing].sort(),
    syntaxErrors,
  };
}

// ---------------------------------------------------------------------------
// Authoring-time checks
// ---------------------------------------------------------------------------

/**
 * Every path the template references, interpolations and conditionals alike.
 * Feeds the settings UI's "variables used" list and the check below.
 */
export function extractVariables(source: string): readonly string[] {
  const found = new Set<string>();
  const collect = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'var') found.add(node.path);
      if (node.kind === 'if') {
        found.add(node.path);
        collect(node.children);
      }
    }
  };
  collect(parse(source.slice(0, MAX_SOURCE_LENGTH)).nodes);
  return [...found].sort();
}

export interface TemplateValidation {
  readonly ok: boolean;
  readonly syntaxErrors: readonly string[];
  /** Referenced but not in the template's declared `variables`, i.e. probable typos. */
  readonly undeclaredVariables: readonly string[];
  /** Declared but never used. Harmless, but usually means a rename went half-done. */
  readonly unusedDeclared: readonly string[];
}

/**
 * The pre-save check. `NotificationTemplate.variables` documents what an event
 * supplies, so comparing it against what the body actually references is what
 * turns `{{studentNmae}}` into a red field in the settings form rather than a
 * blank space in nine hundred SMS messages.
 */
export function validateTemplate(
  source: string,
  declaredVariables: readonly string[],
): TemplateValidation {
  const parsed = parse(source.slice(0, MAX_SOURCE_LENGTH));
  const used = extractVariables(source);
  const declared = new Set(declaredVariables);

  // A dotted path is declared when its root is: an event that documents
  // `invoice` may legitimately use `{{invoice.number}}`.
  const isDeclared = (path: string): boolean =>
    declared.has(path) || declared.has(path.split('.')[0] ?? path);

  const undeclaredVariables = used.filter((path) => !isDeclared(path));
  const unusedDeclared = declaredVariables.filter(
    (name) => !used.some((path) => path === name || path.startsWith(`${name}.`)),
  );

  return {
    ok: parsed.errors.length === 0 && undeclaredVariables.length === 0,
    syntaxErrors: parsed.errors,
    undeclaredVariables,
    unusedDeclared: [...unusedDeclared].sort(),
  };
}
