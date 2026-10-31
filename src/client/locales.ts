/**
 * Copy dictionaries for the queue panel. Chinese is the key source of truth;
 * the English dictionary is type-checked against it.
 * @module dsh-message-queue/client/locales
 */

/** Simplified Chinese dictionary. */
export const zh = {
  count: '{n} 条待发',
  sending: '发送中',
  paused: '已暂停 · {n} 条待发',
  pausedBar: '队列已暂停',
  steeringTitle: '插队待领取 · {n} 条',
  steeringPending: '插队待领取',
  revokeSteering: '撤回插队消息（回到队列）',
  revokeFailed: '撤回消息失败',
  resumeAction: '恢复',
  pauseAll: '暂停队列（全部）',
  resumeAll: '恢复队列（只恢复自动暂停的条目）',
  pauseItem: '暂停这一条',
  resumeItem: '恢复这一条到队列',
  resumeSend: '恢复并立即发送这一条',
  heldManual: '手动暂停',
  heldGlobal: '已暂停',
  edit: '编辑',
  save: '保存',
  cancelEdit: '取消',
  remove: '删除',
  steer: '立即发送',
  moveUp: '上移',
  moveDown: '下移',
  dragHint: '按住拖动排序',
  editFailed: '编辑队列消息失败',
  removeFailed: '删除队列消息失败',
  steerFailed: '发送队列消息失败',
  moveFailed: '调整队列顺序失败',
  pauseFailed: '暂停队列失败',
  resumeFailed: '恢复队列失败',
  pauseItemFailed: '暂停该条消息失败',
  resumeItemFailed: '恢复该条消息失败',
  moved: '已移动到第 {index} 条',
  image: '图片',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  count: '{n} queued',
  sending: 'Sending',
  paused: 'Paused · {n} queued',
  pausedBar: 'Queue paused',
  steeringTitle: 'Pending steering · {n}',
  steeringPending: 'Waiting for the next step',
  revokeSteering: 'Withdraw this steering message (back to the queue)',
  revokeFailed: 'Withdrawing the message failed',
  resumeAction: 'Resume',
  pauseAll: 'Pause the queue (all rows)',
  resumeAll: 'Resume the queue (only rows the queue-wide pause held)',
  pauseItem: 'Pause this message',
  resumeItem: 'Return this message to the queue',
  resumeSend: 'Return this message and send it now',
  heldManual: 'Paused',
  heldGlobal: 'Held',
  edit: 'Edit',
  save: 'Save',
  cancelEdit: 'Cancel',
  remove: 'Remove',
  steer: 'Send now',
  moveUp: 'Move up',
  moveDown: 'Move down',
  dragHint: 'Drag to reorder',
  editFailed: 'Editing the queued message failed',
  removeFailed: 'Removing the queued message failed',
  steerFailed: 'Sending the queued message failed',
  moveFailed: 'Reordering the queue failed',
  pauseFailed: 'Pausing the queue failed',
  resumeFailed: 'Resuming the queue failed',
  pauseItemFailed: 'Pausing this message failed',
  resumeItemFailed: 'Returning this message failed',
  moved: 'Moved to position {index}',
  image: 'Image',
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'messageQueue'

/** One dictionary key. */
export type MessageQueueKey = keyof typeof zh

/** Translate one key, substituting `{name}` parameters. */
export type Translate = (key: MessageQueueKey, params?: Readonly<Record<string, string | number>>) => string
