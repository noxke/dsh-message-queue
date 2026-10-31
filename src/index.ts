/**
 * Host half of dsh-message-queue: mounts the queue controller that reorders
 * and pauses a Session's pending turns.
 * @module dsh-message-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { MessageQueueService } from './service.ts'

/** Loader entry name inside the composed profile tree. */
export const name = 'message-queue'

/** Services that must exist before the controller mounts. */
export const inject = ['agents']

/** Plugin configuration resolved by the profile patch entry. */
export interface Config {
  /** Mount the queue controller. */
  enabled: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
}) as z<Config>

/**
 * Mount the queue controller.
 * @param ctx - Host context carrying the Agent registry.
 * @param config - resolved plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  await ctx.plugin(MessageQueueService)
}

export { MessageQueueService }
export type { ParkedItem, QueueOrder, QueueState } from './wire.ts'
