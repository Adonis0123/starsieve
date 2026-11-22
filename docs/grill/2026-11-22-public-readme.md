# Grill: public-readme

- Date: 2026-11-22
- Pairing: Interviewer claude/main, Proxy codex (via review-loop prefs, host skipped), Red-team skipped: no hard-to-reverse decisions
- Rounds: 2; stopped because the frontier was empty
- Duration: about 12 minutes
- Status: proposed (no decision here has been implemented)

## Plan

「https://github.com/Adonis0123/stars readme 没有优化好，这个你看看如何优化一下，联网搜索，你继续推进吧」

The public README is produced by `renderReadme` in `src/publish/projection.ts`. It must stay deterministic: no timestamps, no star counts (star counts are outside `contentHash`).

## Decisions

| ID  | Question | Decision | Status | Reversibility | Evidence |
| --- | -------- | -------- | ------ | ------------- | -------- |
| Q1 | README 语言 | 全中文；分类名保持原样 | Assumption | easy | `src/panel/i18n.ts` |
| Q2 | 顶部区域 | 标题 → 简介和数量 → 醒目的在线目录入口 → 可点击单列目录（带数量）；不加徽章；生成说明移到页脚 | Decided | easy | https://github.com/maguowei/starred/blob/main/starred/starred.py ; https://github.com/sindresorhus/awesome/blob/main/awesome.md |
| Q3 | 条目行格式 | 单行：`- [owner/repo](url) — 摘要 · 语言 · 标签`；语言用反引号且与标签去重；标签最多 3 个，保留首个类型标签；X 条目用 `X · [@author](url)`；不显示星数 | Decided | easy | `src/publish/projection.ts`; `GLOSSARY.md` |
| Q4 | 长列表组织 | 普通分类章节，全部展开；每节末尾「回到目录」；X 帖按用途混排；标题只放分类名，数量只在目录里 | Decided | easy | https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#section-links |
| Q5 | 待确认与未分类 | 不逐条标待确认；页脚说明「分类与摘要由 AI 辅助整理，待确认状态见在线目录」；「未分类」保留在最后 | Assumption | easy | `src/core/categories.ts` |
| Q6 | 页脚与 starsieve 链接 | 页脚「由 starsieve 自动生成，请勿手改」，现在纯文本；工具公开后一次性改模板加链接；不加开关 | Decided | easy | `docs/adr/0002-private-first-public-projection.md` |
| Q7 | 验收方式 | `node:test` 全文断言（空集合、单一来源、语言去重、标签截取、特殊字符、锚点重复）；两次输出字节一致；只变星数时 README 与 `contentHash` 不变；真实 419 条数据经 `gh api /markdown`（gfm, context Adonis0123/stars）渲染，桌面和手机截图，点击目录、返回链接和在线入口 | Decided | easy | `src/publish/projection.test.ts`; https://docs.github.com/en/rest/markdown/markdown#render-a-markdown-document |
| Q8 | 标题与可复用 | 用户配置可选 `readme.title`，默认「技术收藏」；本收藏配置为「Adonis 的技术收藏」；非空单行，经 `md()` 转义；固定文案进现有 `ZH` 表并纳入文案检查；只做 zh；配置由调用方读取，只把展示选项传给 `renderReadme` | Decided | easy | `src/core/user-config.ts`; `src/panel/i18n.ts` |
| Q9 | 在线目录与数据链接 | 显式 `siteUrl` 配置，不从 `publicRepo` 推导；缺省时省略在线入口和页脚里的在线目录提示；数据链接跟随布局（`repo` → `data/items.json`，`flat` → `items.json`）；生成时不联网 | Decided | easy | https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages |
| Q10 | 中文标题锚点 | 运行时依赖 `github-slugger`，锁版本；每次渲染新建实例，按全文标题出现顺序（含 H1 和「目录」）生成；输入可见文字而非转义后的 Markdown；目录与返回链接复用结果 | Decided | easy | https://github.com/Flet/github-slugger |

## Reasons

### Q2 — 顶部区域

- Reason: 成熟生成器已有「简介、目录、分类列表」结构；徽章和多列目录增加顶部密度。
- Revisit if: 手机截图显示目录占屏过多。

### Q3 — 条目行格式

- Reason: 单行沿用成熟模板；去重和截取只影响展示，公开数据不变；星数会让 README 每天变化。
- Revisit if: 手机截图显示元信息仍干扰摘要阅读。
- Revised 2026-11-22 after the render check (screenshots: language and Tags looked alike as code spans, Chinese tags broke inside code spans): Summary first without its final 。, then `<br><sub>语言 · 标签…</sub>` as plain text.

### Q4 — 长列表组织

- Reason: 默认折叠要读者逐类展开；普通标题支持 GitHub 章节导航，数量变化不改锚点。
- Revisit if: 目录跳转仍解决不了长页浏览。

### Q6 — 页脚

- Reason: 私有工具的链接对公众无用；静态模板输出不随网络变化。
- Revisit if: 工具仓库公开。

### Q7 — 验收

- Reason: Markdown API 只返回 HTML，布局要截图和点击验证。
- Revisit if: GitHub 实际页面与预览不同。

### Q8 — 标题

- Reason: 默认值不能绑定作者；现有翻译模块可复用，但检查要覆盖 README。
- Revisit if: 支持英文界面时，再加 README 与站点共用的语言配置。

### Q9 — 在线目录

- Reason: 仓库名证明不了 Pages 已启用，也推不出自定义域名；数据链接必须跟随实际布局。
- Revisit if: 项目有可直接读取的、已验证的部署地址配置。

### Q10 — 锚点

- Reason: 该包处理中文、大小写和重复后缀，是 GitHub 风格 slug 的常用实现。
- Revisit if: GitHub 实际锚点与锁定版本不同。

## Escalations

None.

## Assumptions

- Q1: 全中文，不加英文副标题（taste，按仓库惯例）。
- Q5: README 不标待确认，页脚说明 AI 辅助整理（taste）。

## Glossary and decision records

- Terms added to `GLOSSARY.md`: none (no new domain terms; README layout is presentation).
- Decision records written: none (all decisions easy to reverse).
