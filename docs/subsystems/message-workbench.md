# 消息队列工作台

## 职责与边界

负责消息队列连接下的订阅管理、流式消费、预览拉取、消息浏览和发布表单状态。不负责 MQTT/Kafka/RabbitMQ/RocketMQ/Pulsar 的连接与协议实现；这些在 `internal/db/` 对应驱动中。

## 真源

- 页面编排：`frontend/src/components/MessageQueueWorkbench.tsx`
- 订阅与流状态：`frontend/src/components/messageQueue/hooks/useMessageQueueWorkbenchState.ts`
- 订阅列表：`frontend/src/components/messageQueue/MessageQueueSubscriptionList.tsx`
- 消息流与详情：`frontend/src/components/messageQueue/MessageQueueStreamPane.tsx`
- 持久化：`frontend/src/utils/messageWorkbenchPersistence.ts`
- 消费/发布草稿：`frontend/src/utils/messageConsume.ts`、`messagePublish.ts`

## 运行时路径

1. 工作台按 `connectionId + executionDbName` 读取本地持久化的订阅草稿和发布草稿。
2. 每个订阅生成命令；MQTT 的 `stream` 订阅通过 `DBQuery` 长轮询持续消费，并使用 `stream_offset` 防止重复。
3. 收到的消息写入当前工作台内存，暂停、恢复、删除分别改变用户意图、运行令牌和消息缓存。
4. `active` 表示用户是否希望该订阅保持启用；`running`、`loading`、错误和消息数量都是瞬时状态。
5. 重新打开工作台时，只自动恢复 `active=true` 的 `stream` 订阅；预览型订阅只恢复配置，不自动消费。

## 状态与不变量

- `active` 必须持久化；暂停写 `false`，恢复写 `true`。
- 旧版本数据没有 `active` 时按启用处理，保持原自动恢复行为。
- 连接运行配置变化时，订阅配置重建，但用户停用状态必须保留。
- 暂停先移除运行令牌，迟到的轮询结果不能再写入消息或计数。
- 删除订阅时同时清理运行令牌、去重集合、流偏移和相关消息。

## 失败语义

- 无效的旧订阅草稿在恢复时丢弃，不影响同作用域其他订阅。
- 本地存储不可写时保持内存状态，并只提示一次持久化失败。
- 消费失败会停止当前运行并显示错误；用户可恢复后重试。
- 组件卸载会尽力向 MQTT 发送 `UNSUBSCRIBE`，本地状态清理不受其失败影响。

## 验证

```bash
cd frontend
npx vitest run src/components/MessageQueueWorkbench.test.tsx src/utils/messageWorkbenchPersistence.test.ts
npx tsc --noEmit
```

MQTT 实机验证需覆盖：暂停订阅、关闭并重新打开工作台、确认不自动重连；恢复后能够继续接收消息。
