# TexLite AI 任务接入：无摘要、多文件上下文协议（v2）

状态：协议与 TexLite 侧实现说明；当前 TexLite 已按 v2 接入。

本文是 TexLite AI 功能的协议和实现依据。TexLite 与 AI Server 之间使用 v2，
不兼容旧的 `contextSummary` 摘要协议；AI Server 必须返回协议版本 2，才能完成
端到端调用。

## 1. 目标和边界

第一版只实现“AI 代替当前用户编辑协作文档”：

- 用户可以在当前文件中选中一段文字后执行操作，例如润色、改写、翻译；
- 用户没有选中文本时，可以从当前光标位置开始让 AI 续写；
- AI 返回的文字由当前用户通过已有 Yjs 协作链路写入目标文件；
- 当前用户在任务完成或放弃前暂时不能继续编辑工作区；其他协作者仍可编辑；
- 任务只在当前协作文档实例存活期间有效，服务重启或实例重建后任务失效；
- AI Server 只负责理解上下文和生成文字，不直接操作 Yjs，也不能写入项目文件。

本次协议调整：

1. 完全删除摘要概念，不再生成、传输或缓存 `summary`/`contextSummary`；
2. 目标编辑文件与可选的上下文文件明确分开；
3. 一次请求可以携带多个项目文件作为只读上下文（严格限制仅支持 `.tex` 与 `.bib` 文本文件）；
4. 添加上下文文件后，必须向用户明确说明：读取的文件越多、越大，推理通常越慢；
5. 提示词仍由 AI Server 管理，TexLite 只发送任务描述和结构化上下文；
6. 增加语言模式 `lang`，由 TexLite 根据项目文档的 CJK 支持情况确定有效值；
7. 不增加数据库表，任务仍以内存状态管理。

本版本的“文件作为上下文”指从当前项目中选择已有的 `.tex` 或 `.bib` 文本文件，
不是上传用户本地文件，也不支持图片、PDF 或日志等其他文件类型。以后如果需要
本地文件上传或其他格式，应另设计上传、病毒检查、解析、存储和权限流程，不能
直接复用本协议中的项目相对路径。

## 2. 术语和处理流程

一次请求有一个目标编辑文件，以及零个或多个上下文文件：

~~~
浏览器
  └─ 任务描述、目标文件、选区、上下文文件路径
       ↓
TexLite
  ├─ 检查项目权限和文件权限（校验上下文文件扩展名仅限 .tex / .bib）
  ├─ 从 Yjs 快照读取目标上下文和上下文文件内容
  ├─ 向 AI Server 发起带 API Key 的服务间请求
  └─ 将 AI 输出通过当前用户的 Yjs 身份写回目标文件
       ↓
AI Server
  ├─ 根据服务端提示词组装上下文
  ├─ 调用模型
  └─ 流式返回目标文件的插入/替换文本
~~~

### 2.1 目标编辑文件

目标文件是用户当前正在编辑的文件。只有它会被 AI 修改，协议中必须明确携带
`targetFilePath`。目标上下文由以下三部分组成：

- `before`：目标位置之前的文本；
- `selectedText`：当前选中的文本，没有选中时为空字符串；
- `after`：目标位置之后的文本。

`replace` 要求选区非空，生成结果替换 `selectedText`；`insert` 要求
`startOffset === endOffset`，生成结果插入光标位置。

### 2.2 语言模式

请求增加 `lang` 字段，取值只能是：

- `en`：要求 AI 返回的自然语言内容使用英文；LaTeX 命令、数学公式、引用键和文件路径不视为自然语言，不应被翻译或删除；
- `any`：不限制自然语言的输出语言，由用户指令、文档上下文和 AI Server 提示词决定。

语言模式由 TexLite 负责确定，AI Server 不需要自行解析项目文件：

1. 检查项目主文档（当前文件就是主文档时检查当前文件）的导言区和文档类声明；
2. 如果发现 `ctex` 文档类、`ctex` 包或 `xeCJK` 包/相关加载声明，则认为项目具备中文排版支持，默认使用 `any`；
3. 如果没有发现上述声明，则默认并强制使用 `en`，避免 AI 生成当前文档无法正常排版的中文内容；
4. 前端的“AI 输出仅英文”复选框对应 `lang=en`；取消勾选对应 `lang=any`。当项目没有检测到 CJK 支持时，服务端仍必须将 `any` 规范化为 `en`，不能通过客户端参数绕过该限制。

这里只判断排版能力，不根据正文中偶然出现的中文字符推断语言。检测应允许常见的文档类选项、包选项、空白和注释。语言限制只约束 AI 生成的自然语言，不约束已有的 TeX 语法、命令、数学和 BibTeX 标识符。

### 2.3 上下文文件

上下文文件是用户主动选择的项目内其他 `.tex` 或 `.bib` 文本文件，只读，不会
被 AI 修改。它们用于补充宏定义、其他章节内容（`.tex`）或参考文献条目（`.bib`）。
上下文文件可以有多个，顺序按用户在界面中的选择顺序传递；服务端需要按路径去重。

**文件类型严格限制**：上下文文件扩展名必须是 `.tex` 或 `.bib`（大小写不敏感，
如 `.tex`、`.bib`、`.TEX`、`.BIB`）。严禁传入图片、编译日志、PDF、样式文件或
其他格式，否则应直接拒绝并返回 `AI_CONTEXT_FILES_INVALID`。

目标文件不能重复出现在 `contextFiles` 中。上下文文件不能使用绝对路径、路径
遍历或项目外路径。

### 2.4 任务生命周期

任务仍然是内存任务，不落库。TexLite 至少需要维护：

- 任务状态：`preparing`、`generating`、`applying`、`done`、`error`、
  `cancelled`；
- 请求 ID；
- 当前用户、项目、目标文件；
- 目标内容版本或用于冲突检测的指纹；
- 本次请求是否携带上下文文件。

AI 返回后，只有目标文件仍符合写回条件时才能应用结果。其他协作者在等待期间
修改了目标文件时，不得无条件覆盖其修改，应返回冲突并要求用户重新发起任务。
上下文文件在请求提交后发生变化不影响本次任务，因为 AI 使用的是提交时捕获的
只读快照。

## 3. 浏览器到 TexLite 的接口

建议保留现有的任务入口，在请求结构中采用明确的目标文件命名：

~~~json
{
  "requestId": "8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0",
  "targetFilePath": "main.tex",
  "operation": "replace",
  "lang": "en",
  "promptId": "polish",
  "taskDescription": "润色这段文字，使表达更正式，但不要改变数学含义。",
  "startOffset": 120,
  "endOffset": 268,
  "contextFiles": [
    "chapters/method.tex",
    "refs/references.bib"
  ]
}
~~~

字段约定：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `requestId` | 是 | 浏览器生成的幂等请求 ID。 |
| `targetFilePath` | 是 | 要编辑的项目相对路径。 |
| `operation` | 是 | `replace` 或 `insert`。 |
| `lang` | 是 | `en` 或 `any`；表示 AI 返回内容的语言约束。 |
| `promptId` | 否 | 服务端提示词模板 ID，例如 `polish`；缺省时使用对应操作的默认提示词。 |
| `taskDescription` | 是 | 用户本次任务的具体要求，不由摘要替代。 |
| `startOffset` | 是 | 目标文件中的起始偏移。 |
| `endOffset` | 是 | 目标文件中的结束偏移。 |
| `contextFiles` | 否 | 项目相对路径数组（仅限 `.tex` 与 `.bib` 文件），缺省为空数组。 |

当前协议要求前后端都显式携带 `lang`；缺省或非法值应直接返回
`AI_LANGUAGE_INVALID`，不能依赖 AI Server 猜测语言。

偏移继续使用 TexLite 当前编辑器约定；它们只作用于
`targetFilePath`，不会作用于上下文文件。浏览器只提交路径，不提交上下文文件
内容；内容由 TexLite 在服务端做权限检查后从当前 Yjs 文档快照读取，避免客户端
伪造项目文件内容。

### 3.1 前端交互

AI 菜单至少包含：

- 有选区时：润色、改写、翻译等 `replace` 操作；
- 无选区时：续写等 `insert` 操作；
- 显示“AI 输出仅英文”复选框：勾选发送 `lang=en`，取消勾选发送 `lang=any`；
- “添加上下文文件”入口，仅展示并允许选择项目内的 `.tex` 和 `.bib` 文本文件；
- 已选择的上下文文件列表，以及逐个移除操作。

当 `contextFiles` 非空时，在发送按钮附近显示明确的小字提示：

> 已添加上下文文件。AI 需要读取更多内容，推理可能明显变慢；文件越多、内容越大，
> 等待时间通常越长。

查找/选择上下文文件期间应显示加载状态。提交后当前用户的工作区保持忙碌或只读状态，
但其他协作者不受影响。取消任务时应中止远端请求，并恢复当前用户的
编辑能力。

## 4. 上下文捕获和固定限制

本版本不把限制暴露为用户配置，也不再提供 `maxSummaryBytes` 或任何摘要配置。
限制是协议安全边界，代码中使用固定常量；后续若要调整，应作为协议版本或部署
级别变更处理。

建议 v2 的固定上限如下：

| 内容 | 上限 |
| --- | ---: |
| 上下文文件数量 | 3 个（仅限 `.tex` 与 `.bib`） |
| 单个上下文文件 UTF-8 字节数 | 256 KiB |
| 所有上下文文件合计 UTF-8 字节数 | 1 MiB |
| 目标文件 `before` | 64 KiB |
| 目标文件 `selectedText` | 32 KiB |
| 目标文件 `after` | 32 KiB |
| AI 输出 | 32 KiB |

这些上限不是让用户填写的参数。TexLite 和 AI Server 都必须校验，不能只依赖
前端；超过上限时返回明确错误，不要静默截断，以免模型得到不完整上下文后覆盖
用户内容。

捕获规则：

1. 先校验当前用户对目标文件和每个上下文文件都有项目读取权限；
2. 规范化相对路径，严格检查扩展名仅允许 `.tex` 或 `.bib`（大小写不敏感），拒绝绝对路径、`..`、重复路径、非 `.tex`/`.bib` 格式以及目标文件重复项；
3. 从一个逻辑时间点读取目标上下文和所有上下文文件；
4. 检查 UTF-8 字节限制；
5. 将上下文文件按稳定顺序传给 AI Server，并保留文件路径标签；
6. 不把上下文文件作为可写目标，也不允许 AI 返回多个文件的修改指令。

目标文件本身可因 `before`、`selectedText`、`after` 三部分合计超过限制而被
拒绝。上下文文件内容和任务描述不能完整写入普通应用日志。

## 5. TexLite 到 AI Server 的 v2 协议

请求发送到配置的 AI Server，例如：

`POST {AI.baseURL}/api/texlite/ai/generate`

使用服务间 API Key（`Authorization: Bearer <AI.apiKey>`），不要把浏览器 Cookie 转发给 AI Server。
请求示例：

~~~json
{
  "protocolVersion": 2,
  "requestId": "8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0",
  "actor": {
    "userId": "user-123",
    "username": "zhongpu",
    "nuwaxSubject": "nuwax-sub-456"
  },
  "projectId": "project-9de10dda",
  "taskType": "writing",
  "operation": "replace",
  "lang": "en",
  "target": {
    "filePath": "main.tex",
    "before": "本文首先介绍研究背景……",
    "selectedText": "本文提出一种方法。",
    "after": "实验结果见表 1。"
  },
  "contextFiles": [
    {
      "filePath": "chapters/method.tex",
      "content": "\\section{方法}\n本研究采用……"
    },
    {
      "filePath": "refs/references.bib",
      "content": "@article{example2026, ...}"
    }
  ],
  "promptId": "polish",
  "taskDescription": "润色这段文字，使表达更正式，但不要改变数学含义。",
  "limits": {
    "maxOutputBytes": 32768
  }
}
~~~

其中：

- `target` 是唯一允许被修改的文件及其直接上下文；
- `lang` 只能是 `en` 或 `any`；AI Server 必须将它作为生成约束传给提示词组装层；
- `contextFiles` 缺省为 `[]`，每一项都是只读内容；
- AI Server 不能根据文件内容自行决定修改其他文件；
- `nuwaxSubject` 是 Nuwax 的原始稳定用户 ID（可选但建议携带），仅作为
  服务端按用户限额、审计和排障的关联键，不替代 TexLite 的权限判断；
- `limits` 只允许 TexLite 给出服务端认可的安全上限，不能被浏览器任意放大；
- 不再出现 `contextSummary`、`summary`、`summaryPolicy` 或
  `maxSummaryBytes`。

### 5.1 AI Server 提示词组装

提示词文件、模型选择和模型参数全部由 AI Server 配置。TexLite 不发送完整提示词
模板，只发送 `promptId`、`taskDescription` 和结构化上下文。

AI Server 的组装顺序建议为：

1. 系统提示词；
2. 当前任务操作提示词（replace 或 insert）；
3. 语言约束（`en` 或 `any`）；
4. 目标文件路径和目标上下文；
5. 每个上下文文件的路径和完整内容；
6. 用户的 `taskDescription`；
7. 输出格式约束。

上下文文件内容必须使用清晰的分隔符，并标记为“参考文档内容”，不能当作系统
指令执行。项目文件中可能存在类似提示词的文字，AI Server 需要将其视为数据，
防止间接提示词注入。

### 5.2 流式返回

推荐 AI Server 使用 NDJSON 流式返回，HTTP 成功后每行一个 JSON 事件：

~~~json
{"protocolVersion":2,"requestId":"8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0","type":"status","phase":"preparing"}
{"protocolVersion":2,"requestId":"8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0","type":"status","phase":"generating"}
{"protocolVersion":2,"requestId":"8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0","type":"delta","text":"本文提出"}
{"protocolVersion":2,"requestId":"8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0","type":"delta","text":"了一种方法。"}
{"protocolVersion":2,"requestId":"8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0","type":"done","resultText":"本文提出了一种方法。"}
~~~

约定：

- `status` 只能使用 `preparing` 和 `generating` 等非摘要阶段；
- `delta` 可以为零个或多个，按顺序拼接；
- `done` 正常结束时必须恰好一个，并带完整 `resultText`；
- `done.resultText` 应与所有 `delta.text` 拼接后的结果一致；
- 不发送摘要事件，不发送 `contextSummary`；
- 发生错误时发送一个 `error` 终止事件，之后关闭连接；
- 客户端断开时，TexLite 应取消请求，AI Server 应尽力取消模型调用。

非流式降级响应可以使用：

~~~json
{
  "protocolVersion": 2,
  "requestId": "8c5b7f67-3fa8-4e56-9f25-7a1f0b07e9a0",
  "resultText": "本文提出了一种方法。"
}
~~~

## 6. 错误处理

TexLite 需要区分用户输入错误、服务端拒绝和临时故障。建议错误码至少包括：

| 错误码 | 含义 |
| --- | --- |
| `AI_UPSTREAM_INVALID_RESPONSE` | AI Server 不支持协议 v2、返回错误 JSON 或流式事件不完整。 |
| `AI_TARGET_INVALID` | 目标文件、操作或选区不合法。 |
| `AI_CONTEXT_FILES_INVALID` | 上下文路径重复、越界、目标文件重复或文件类型不支持（仅允许 `.tex` 与 `.bib`）。 |
| `AI_CONTEXT_TOO_LARGE` | 上下文文件数量或字节数超过固定上限。 |
| `AI_LANGUAGE_INVALID` | `lang` 不是 `en` 或 `any`，或语言约束无法满足。 |
| `AI_PERMISSION_REVOKED` | 当前用户不再拥有项目编辑权限。 |
| `AI_OUTPUT_TOO_LARGE` | 生成结果超过输出限制。 |
| `AI_UPSTREAM_TIMEOUT` | 远端在超时前未完成。 |
| `AI_UPSTREAM_UNAVAILABLE` | AI Server 不可用或连接失败。 |
| `AI_TARGET_CONFLICT` | 目标文件在任务期间发生变化，未写回结果。 |
| `AI_TASK_CANCELLED` | 用户取消或客户端断开。 |
| `AI_TASK_NOT_FOUND` | 预览已过期、服务重启或已被放弃。 |
| `AI_INTERNAL_ERROR` | AI Server 或 TexLite 内部错误。 |

超时、断网、错误 JSON、错误协议版本、缺少终止事件都必须让任务进入
`error`，恢复当前用户编辑能力，且不能部分写入目标文件。重试必须生成新的
`requestId`，不能重复应用同一个已经写回的结果。

## 7. 安全和权限

- TexLite 仍是唯一的项目权限判断者；AI Server 不能通过 API Key 获得项目读写权；
- AI Server 只收到本次请求选择的文件内容，不应访问 TexLite 文件系统或数据库；
- 服务间 API Key 只放在服务端配置，不能出现在浏览器请求、前端 bundle 或普通日志；
- `actor.nuwaxSubject` 作为不透明字符串使用，不在客户端显示，也不能由浏览器
  自己提交后直接信任；
- AI Server 日志默认只记录 request ID、用户关联键、项目 ID、文件数量、字节数和
  耗时，不记录完整任务描述、目标文本或上下文文件内容；
- 上下文文件是只读参考，生成结果永远只能写入目标文件；
- 写回前必须再次检查目标文件版本/指纹，防止覆盖协作者的新内容。

## 8. TexLite 侧实现改动清单

当前实现包括：

1. `src/shared/aiProtocol.ts`：协议版本改为 2；删除摘要类型、摘要事件和摘要
   限制；增加 `target`、`contextFiles`、`lang` 类型（限定文件仅限 `.tex` 与 `.bib`）；
2. `src/server/routes/projectAi.ts`：校验目标文件和多文件路径与扩展名（仅限 `.tex` 与 `.bib`），捕获 Yjs 内容，
   强制权限检查、语言模式和固定大小限制；
3. `src/server/aiService.ts`：把目标上下文和上下文文件直接发送给 AI Server，
   删除摘要请求、摘要缓存和摘要合并逻辑；
4. `src/client/ai.ts` 及 AI 菜单：增加多选项目文件（仅限 `.tex` 与 `.bib`）、已选列表、移除操作和慢速
   推理提示；任务执行期间锁定当前用户的整个工作区编辑；
5. 任务状态：保留内存任务和取消逻辑，不新增数据库表；
6. 写回逻辑：继续以当前用户 Yjs 身份写入目标文件，并增加/保留目标版本冲突保护；
7. 测试：覆盖零上下文、单个上下文、多个上下文、非 `.tex`/`.bib` 格式拒绝、重复/越界/超限、超时、取消、
   流式增量、目标冲突以及服务重启后任务失效。

## 9. 实现顺序和验收标准

建议顺序：

1. 先在 `../TexLite-AI` 实现并测试 AI Server v2；
2. 用固定 JSON 请求验证无上下文、单文件和多文件上下文；
3. 验证 AI Server 完全不依赖摘要字段，旧的摘要提示词和摘要事件都删除；
4. 再修改 TexLite 的共享协议、服务端捕获、客户端 UI 和 Yjs 写回；
5. 最后使用 `npm run dev` 做端到端验证。

AI Server 侧完成后应满足：

- `protocolVersion: 2` 能被接受，v1 或缺少版本能明确拒绝；
- `contextFiles: []` 与不带该字段等价；
- `lang=en` 时自然语言结果为英文，`lang=any` 时不限制语言；非法 `lang` 被明确拒绝；
- 未检测到 `ctex`/`xeCJK` 支持时，TexLite 不允许通过请求参数选择 `any`；
- 多个上下文文件按路径和内容进入模型上下文；
- 上下文文件只影响推理，不产生额外文件修改；
- 不存在摘要请求、摘要事件、摘要配置和摘要提示词；
- 流式 `delta` 拼接结果等于 `done.resultText`；
- 超限、非法路径、非 `.tex`/`.bib` 格式文件、重复文件和目标文件重复都返回明确错误；
- 能模拟上下文较多时的延迟，方便 TexLite 验证“可能较慢”的 UI 提示。
