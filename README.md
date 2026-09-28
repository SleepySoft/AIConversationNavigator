# AI Conversation Navigator

## 起因

公司指定的AI工具是Copilot。和微软的其它产品一样，它的网页非常重，并且还使用了动态加载内容到DOM的方式，再加上GPT的回复本来就又长啰嗦，导致在Copilot网页上翻找对话体验非常差。

网上有不少GPT网页对话增强工具，但针对Copilot的工具我没找到。好在有AI，而且写个满足我需求的插件又不难，于是我自己弄了一个。

当然，在架构设计阶段我已预留相应的扩展接口，使其能够较为轻松地适配其他 AI 网页平台。接下来视情况可能会加入其它AI平台的支持。

这是个Chrome插件，大家完全可以让AI改造成Edge等chome内核浏览器可用的插件，并定制自己的功能。本插件实现的功能和解决的痛点如下：


## 功能

- 缓存每一个加载过的会话，可以导出成markdown格式的文件 ---- 解决导出对话内容困难的问题。

- 将每轮对话组织成列表，对于在当前DOM中的，点击可直接跳转 ---- 解决翻找圣诞困难的问题。

- 对于已加载过的对话内容，可以直接点击列表的预览按钮查看；预览会排版 Markdown、表格、代码和数学公式 ---- 解决翻找时等待加内容加载的问题。
> 如果插件的Progress没有显示100%，可以使用Auto scroll功能，让它从头到尾滚一遍，确保加载所有对话。
> 已有纯文本缓存的预览和导出会尽量整理公式、表格与代码块，但无法凭文本完全还原原网页。重新打开相关对话，或使用 Auto scroll 重新采集，才能补齐原始格式和公式源码。Navigator 标题旁显示当前实际运行的版本。

- 只在每轮用户发送的内容前显示序号 ---- 和列表内容对照，让用户明确知道自己浏览的是第几轮对话。

## 使用

1. clone本项目，或下载本项目的压缩包并解压：[https://github.com/SleepySoft/AIConversationNavigator](https://github.com/SleepySoft/AIConversationNavigator)
2. 打开 [chrome://extensions/](chrome://extensions/)
3. 开启 Developer mode
4. 点击 Load unpacked
5. 选择本仓库根目录
6. 打开 https://m365.cloud.microsoft/chat
7. 展开页面右下角的 Navigator 面板

## 开发

扩展已包含构建好的 Markdown 和公式渲染资源，直接按上述步骤加载即可。修改 `src/preview-renderer.js`、`src/providers/` 或更新依赖后，运行 `npm ci && npm run build`，再重新加载扩展并刷新 Copilot 页面。运行 `npm test` 可检查预览渲染。

`src/preview-renderer.js` 只负责把缓存中的 Markdown 渲染成预览 HTML。Copilot 页面 DOM 到 Markdown 的转换在 `src/providers/copilot-markdown.js`，旧版纯文本缓存的兼容处理在 `src/providers/copilot-legacy.js`，并由 `CopilotProvider` 调用。增加其他网站时，采集与特殊格式处理应放在对应 Provider 中，预览层复用同一个 Markdown 渲染器。
