# Description

## 中文版

dsh-smart-title 是 DeepSeek Harness（DSH）的智能会话标题插件：等第一轮完整对话以任意原因结束（完成、中止、出错、封顶）后再总结标题，比只看首条提问更准；等待经快照、订阅、复查三步防竞态，瞬间结束的一轮也不漏。失败时提交本地化占位标题并记警告日志，配合聊天头部 ✎ 按钮一键重试，不再静默返回空标题；✎ 单击经显式刷新标记总结对话现状，Shift+单击手动改名，用户命名由服务钉住永不被自动覆盖。标题输入按路径配额做 UTF-8 字节安全截断，输出经首行提取与反引用正则剥壳净化；调度、改名钉住与审计复用官方 sessionTitle 服务与 session-title-llm 共享库，不重复造轮子。

## English

dsh-smart-title is a smart session titler plugin for DeepSeek Harness (DSH). It waits for the first FULL conversation turn to end — any end reason, since turn/end is always appended in the agent loop's finally — then summarizes the exchange into the title, so the name reflects what the assistant actually did rather than the opening prompt alone; the wait runs a snapshot → subscribe → re-check sequence so a turn ending in between cannot be missed. Failure is visible by design: a localized placeholder title plus a host warning replaces the silent null, and the chat-header ✎ button retries it in one click; the button's plain click regenerates over the conversation as it stands via an explicit refresh marker consumed by the provider, Shift+Click renames manually, and user-renamed titles are pinned and never overwritten by the automatic path. Title inputs are UTF-8-safe and byte-budgeted per path so multi-byte characters never split; outputs are cleaned through first-line extraction and a backreference regex that unwraps markdown emphasis; scheduling, rename pinning and audit events are reused from the official sessionTitle service and the session-title-llm shared library instead of reimplemented.
