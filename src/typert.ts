/**
 * Host Typert manifest exported as `./typert`: the harness typert loader
 * discovers it from the package entry and registers the `messageQueue`
 * invocations when this plugin mounts.
 * @module dsh-message-queue/typert
 */

import { MESSAGE_QUEUE_INVOCATIONS, MESSAGE_QUEUE_PACKAGE } from './wire.ts'

/** Host face contribution validated by `@deepseek-ai/dsh-typert-loader`. */
export const TYPERT = Object.freeze({
  package: MESSAGE_QUEUE_PACKAGE,
  face: 'host' as const,
  schemas: Object.freeze([]),
  invocations: MESSAGE_QUEUE_INVOCATIONS,
  model: Object.freeze({
    services: Object.freeze([]),
    events: Object.freeze([]),
    objects: Object.freeze([]),
  }),
})
