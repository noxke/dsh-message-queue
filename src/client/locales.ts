/**
 * Copy dictionaries for the queue panel. Chinese is the key source of truth;
 * the English dictionary is type-checked against it.
 * @module dsh-message-queue/client/locales
 */

/** Simplified Chinese dictionary. */
export const zh = {
  queue: '队列',
  count: '{n} 条待发',
  sending: '发送中',
  paused: '已暂停 · {n} 条待发',
  pause: '暂停队列',
  resume: '恢复队列',
  pausedBar: '队列已暂停',
  resumeAction: '恢复',
  edit: '编辑',
  save: '保存',
  cancelEdit: '取消',
  remove: '删除',
  steer: '立即发送',
  steerUnavailable: '当前没有运行中的任务',
  moveUp: '上移',
  moveDown: '下移',
  moveTop: '移到队首',
  moveBottom: '移到队尾',
  dragHint: '拖动排序',
  parked: '已暂存',
  parkedHint: '恢复队列后可编辑或排序',
  empty: '队列为空',
  editFailed: '编辑队列消息失败',
  removeFailed: '删除队列消息失败',
  steerFailed: '发送队列消息失败',
  moveFailed: '调整队列顺序失败',
  pauseFailed: '暂停队列失败',
  resumeFailed: '恢复队列失败',
  position: '第 {index} 条，共 {total} 条',
  moved: '已移动到第 {index} 条',
  image: '图片',
  file: '{name}',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  queue: 'Queue',
  count: '{n} queued',
  sending: 'Sending',
  paused: 'Paused · {n} queued',
  pause: 'Pause queue',
  resume: 'Resume queue',
  pausedBar: 'Queue paused',
  resumeAction: 'Resume',
  edit: 'Edit',
  save: 'Save',
  cancelEdit: 'Cancel',
  remove: 'Remove',
  steer: 'Send now',
  steerUnavailable: 'No running task to steer into',
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveTop: 'Move to front',
  moveBottom: 'Move to end',
  dragHint: 'Drag to reorder',
  parked: 'Held',
  parkedHint: 'Resume the queue to edit or reorder',
  empty: 'The queue is empty',
  editFailed: 'Editing the queued message failed',
  removeFailed: 'Removing the queued message failed',
  steerFailed: 'Sending the queued message failed',
  moveFailed: 'Reordering the queue failed',
  pauseFailed: 'Pausing the queue failed',
  resumeFailed: 'Resuming the queue failed',
  position: 'Item {index} of {total}',
  moved: 'Moved to position {index}',
  image: 'Image',
  file: '{name}',
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'messageQueue'

/** One dictionary key. */
export type MessageQueueKey = keyof typeof zh

/** Translate one key, substituting `{name}` parameters. */
export type Translate = (key: MessageQueueKey, params?: Readonly<Record<string, string | number>>) => string
