# AI Conversation Navigator

## 起因

公司指定的AI工具是Copilot。和微软的其它产品一样，它的网页非常重，并且还使用了动态加载内容到DOM的方式，再加上GPT的回复本来就又长啰嗦，导致在Copilot网页上翻找对话体验非常差。

网上有不少GPT网页对话增强工具，但针对Copilot的工具我没找到。好在有AI，而且写个满足我需求的插件又不难，于是我自己弄了一个。

这是个Chrome插件，大家完全可以让AI改造成Edge等chome内核浏览器可用的插件，并定制自己的功能。本插件实现的功能和解决的痛点如下：


## 功能

- 缓存每一个加载过的会话，可以导出成markdown格式的文件 ---- 解决导出对话内容困难的问题。
- 将每轮对话组织成列表，对于在当前DOM中的，点击可直接跳转 ---- 解决翻找圣诞困难的问题。
- 对于已加载过的对话内容，可以直接点击列表的预览按钮查看 ---- 解决翻找时等待加内容加载的问题。
- 对每轮会话增加index显示 ---- 和列表内容对照，让用户明确知道自己浏览的是第几轮对话。

## 使用

1. clone本项目，或下载本项目的压缩包并解压：[https://github.com/SleepySoft/AIConversationNavigator](https://github.com/SleepySoft/AIConversationNavigator)
2. 打开 [chrome://extensions/](chrome://extensions/)
3. 开启 Developer mode
4. 点击 Load unpacked
5. 选择本仓库根目录
6. 打开 https://m365.cloud.microsoft/chat
7. 展开页面右下角的 Navigator 面板
