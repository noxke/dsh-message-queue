/**
 * Client Typert contribution for the `messageQueue` namespace. It mounts the
 * exact descriptors the Host manifest exports, so both wire codecs agree.
 * @module dsh-message-queue/client/remote
 */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { MESSAGE_QUEUE_INVOCATIONS, MESSAGE_QUEUE_PACKAGE } from '../wire.ts'

/** Mountable Client contribution owning `remote.messageQueue`. */
export const MESSAGE_QUEUE_REMOTE: TypertRemoteContribution = Object.freeze({
  package: MESSAGE_QUEUE_PACKAGE,
  descriptors: MESSAGE_QUEUE_INVOCATIONS,
})
