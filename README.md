# AI Conversation Navigator

V0.2 可运行实现，用于采集 Microsoft 365 Copilot 会话、生成用户消息 Outline、统计 Coverage、持久化会话并导出 Markdown。

## 功能

- Copilot 会话切换检测
- DOM / 滚动增量采集与去重
- Coverage 与缺失范围统计
- 用户消息 Outline
- Outline 项显示 Ready / Unloaded 挂载状态
- 对话正文前显示 #001 格式序号
- 未加载的空 Assistant 内容不会被记录或导出
- IndexedDB 持久化
- Markdown 导出
- 自动滚动补全模式
- 浮动 Navigator 面板

## 以 Chrome 扩展调试

1. 打开 chrome://extensions/
2. 开启 Developer mode
3. 点击 Load unpacked
4. 选择本仓库根目录
5. 打开 https://m365.cloud.microsoft/chat
6. 使用页面右下角的 Navigator 面板

## 以油猴脚本调试

1. 安装 Tampermonkey / Violentmonkey
2. 新建脚本并导入 src/navigator.user.js
3. 保存后刷新 Copilot 页面

## 控制台调试

脚本暴露 window.__AI_CONVERSATION_NAVIGATOR__，可以访问 state.currentSession，或调用 collect、toggleAutoScroll、exportMarkdown。
