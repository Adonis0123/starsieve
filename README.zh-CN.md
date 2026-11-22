# starsieve

[English](README.md) | 简体中文

starsieve 把你在 GitHub 上 star 的仓库，以及你在 X 上点赞或收藏的技术帖子，分进各个 Category（分类）。分类工作交给任意一个 agent CLI，它在这里叫 Classifier（分类器）。starsieve 只发布允许公开的 Item（收藏条目）。术语以 [GLOSSARY.md](GLOSSARY.md) 为准，设计决定记在 [docs/adr](docs/adr)。

目前已经实现：collect（GitHub stars、X 点赞和收藏）、Backfill（回填，从头把 X 列表完整读一遍）、classify、apply、override（以及 unskip）、publish、check、Portal Panel（本机工具门户里的面板）、公开站点构建、每日 `run`（git commit 和 push、开启自动合并的 PR、Heartbeat 心跳记录）、GitHub Lists 同步、两个数据仓库的 CI 模板，以及 LaunchAgent。

## 环境要求

- macOS。`schedule` 会安装一个 LaunchAgent，日志和保存下来的 Classifier 输出写到 `~/Library/Logs/starsieve/`。
- Node 22.18+（直接运行 TypeScript 源码）和 pnpm。
- `gh` 已登录（`gh auth login`），登录账号是两个数据仓库的所有者。它默认的 `repo` 权限范围足够读取你的 stars（`gh api user/starred`，私有仓库的 star 也包括在内）、push，以及每日 PR（`gh pr create`、`gh pr merge --auto`）。`run` 还会同步 GitHub Lists（`gh api graphql`：`viewer.lists`、`createUserList`、`updateUserListsForItem`）；如果 GitHub 因缺少权限范围拒绝这些请求，就加上 `user`：`gh auth refresh -s user`。git 通过 `gh` 走 HTTPS 时，push `init data` 写出的 `.github/workflows/` 文件需要 `workflow` 权限范围：`gh auth refresh -s workflow`。`init github --dry-run` 打印的命令会修改仓库设置，所以需要公开仓库的 admin 权限。
- 一个充当 Classifier 的 agent CLI，默认是 `cursor-agent`（换用其他 CLI 前先读 [Classifier](#classifier)）。
- 采集 X（可选）：需要 `ego-browser` CLI，并且它的 `Default` profile 已登录 x.com。没有它时，在用户配置里设置 `"collectX": false`，`run` 就会跳过 X。
- Local Tools Portal（本机工具门户，可选）：只有 Panel 需要它；`site build` 和 `run` 不依赖它。

默认的 Category Table（分类表，`categories init`）是中文的，每个 Category 另有英文名（`nameEn`）。可以用 `categories set --file` 替换分类表。`publish` 写两份 README：英文的 `README.md`（分类用英文名，摘要和标签保持中文）和中文的 `README.zh-CN.md`；标题由 `readme.title` 设置。

## 快速开始

`<owner>` 是你的 GitHub 登录名；`stars-private` 和 `stars` 只是示例名。

1. 克隆本仓库并安装依赖：

   ```sh
   git clone https://github.com/Adonis0123/starsieve && cd starsieve
   pnpm install
   ```

2. 建一个私有仓库存放 Private Store（私有存储），再建一个公开仓库存放公开目录。两个仓库的 `main` 上都要有第一个提交。然后把两个都克隆下来：

   ```sh
   gh repo create <owner>/stars-private --private --add-readme
   gh repo create <owner>/stars --public --add-readme
   gh repo clone <owner>/stars-private ~/stars-private
   gh repo clone <owner>/stars ~/stars
   ```

3. 把 CI 文件写进两个克隆（store 就是私有克隆本身；`--store <dir>` 可以指定其中的一个子目录），然后自己 commit 并 push：

   ```sh
   pnpm starsieve init data --private ~/stars-private --public ~/stars
   git -C ~/stars-private add .github && git -C ~/stars-private commit -m "add heartbeat check" && git -C ~/stars-private push
   git -C ~/stars add .github && git -C ~/stars commit -m "add data check" && git -C ~/stars push
   ```

4. 填充 store，并分类一个 Batch（批次；剩下的由 `run` 分类）：

   ```sh
   pnpm starsieve categories init --store ~/stars-private
   pnpm starsieve collect github --store ~/stars-private
   pnpm starsieve classify --store ~/stars-private --limit 25
   ```

5. 看看哪些内容会公开：`publish --dry-run` 统计公开 Item 的数量，不写任何文件；`site build` 把站点写进一个临时目录（`run` 会把正式文件写进公开克隆）：

   ```sh
   pnpm starsieve publish --store ~/stars-private --out /tmp/starsieve-preview --dry-run
   pnpm starsieve site build --store ~/stars-private --out /tmp/starsieve-preview/site
   ```

6. 写 `~/.config/starsieve/config.json`。`run` 至少需要下面这些键；如果已经为 X 配好 ego-browser，就去掉 `collectX`。全部键见 [配置](#配置)。

   ```json
   { "storePath": "~/stars-private", "publicRepoPath": "~/stars", "publicRepo": "<owner>/stars", "collectX": false }
   ```

7. `pnpm starsieve run --dry-run` 打印执行计划；`pnpm starsieve run --no-push` 跑完全部步骤，但只在本地 commit。

8. `pnpm starsieve init github --dry-run` 打印几条 `gh api` 命令：开启自动合并、用 `check` job 保护 main、从 `/docs` 提供 Pages。这些命令需要你自己运行。

9. `pnpm starsieve schedule install` 让 `run` 每天 08:17 运行。在 `schedulePush` 设为 `true` 之前，它会带上 `--no-push`。

## 配置

配置文件有两个：

- `~/.config/starsieve/config.json`（设置了 `$XDG_CONFIG_HOME` 时是 `$XDG_CONFIG_HOME/starsieve/config.json`）存放本机设置，不进任何仓库。每个键都是可选的；`~/` 和相对路径（相对于该文件所在目录）会被展开。全部键如下：

  ```json
  {
    "storePath": "~/stars-private",
    "publicRepoPath": "~/stars",
    "publicRepo": "<owner>/stars",
    "siteUrl": "https://<owner>.github.io/stars/",
    "readme": { "title": "技术收藏" },
    "portalCss": "~/path/to/local-tools.css",
    "collectX": true,
    "schedulePush": false,
    "scheduleMaxBatches": 4,
    "mergeTimeoutMs": 1200000
  }
  ```

  | 键 | 默认值 | 含义 |
  | --- | --- | --- |
  | `storePath` | 无 | Private Store：`run` 和 `lists sync` 的 `--store`，也是 Panel 展示的 store。其他命令通过 `--store` 指定。 |
  | `publicRepoPath` | 无 | 公开仓库的本地克隆：`run` 和 `lists sync` 的 `--public`。 |
  | `publicRepo` | 无 | 公开仓库的 `owner/name`，供 `gh` 使用（PR、`init github`），也用于检查 store 永远不会 push 到它。 |
  | `siteUrl` | 无 | 公开站点地址，README 会链接到它；不会根据 `publicRepo` 猜测。 |
  | `readme.title` | Tech collection / 技术收藏 | 发布出去的两份 README 的标题：一行字符串两种语言共用，或写成 `{ "en": …, "zh": … }` 分别设置（缺的那个用默认值）。 |
  | `portalCss` | 无 | Portal 的 `local-tools.css`，`site build` 会内联它，代替 `src/site/default.css`。没有 Portal 时不要写这个键：文件不存在会让 `site build` 和 `run` 失败。 |
  | `collectX` | `true` | `false`：`run` 跳过 `collect-x`（该步骤显示为 `skipped`）；store 里已有的 X Item 照常发布。 |
  | `schedulePush` | `false` | `true`：LaunchAgent 的 `run` 会 push；否则它带上 `--no-push`。 |
  | `scheduleMaxBatches` | 无 | LaunchAgent 的 `run --max-batches`。 |
  | `mergeTimeoutMs` | 1200000（20 分钟） | `run` 等待公开 PR 合并的时长。 |

  `schedulePush` 和 `scheduleMaxBatches` 会写进 plist，所以改了它们之后要重新运行 `schedule install`。

- store 自己的 `config.json` 放在 Private Store 里，随 store 一起提交，只设置 Classifier：`{schemaVersion, classifier: {command, timeoutMs}}`（见 [Classifier](#classifier)）。

## 命令

```sh
pnpm starsieve collect github --store <dir>          # 通过 gh 拉取全部 star；重复运行结果不变
pnpm starsieve collect x --store <dir> [--signal likes|bookmarks|all] [--known-stop 20] [--max-scrolls 40]
pnpm starsieve backfill x --store <dir> [--signal likes|bookmarks|all] [--max-scrolls 400]
pnpm starsieve categories init --store <dir>         # 写入默认 Category Table，仅在还没有时
pnpm starsieve categories set --store <dir> --file <json> [--reclassify]  # 替换分类表；--reclassify 让未锁定的 Classifier 分类结果重新变成待分类
pnpm starsieve pending --store <dir> --limit 25 [--source github|x]  # 下一个 Batch（JSON）
pnpm starsieve classify --store <dir> --limit 25 [--source github|x] # 对一个 Batch 运行 Classifier，然后 apply
pnpm starsieve apply --store <dir> --file batch.json # 写入分类结果的唯一途径
pnpm starsieve override <id> --store <dir> [--category X] [--tags a,b] [--summary S] [--visibility public|private]
pnpm starsieve override <id> --store <dir> --unskip  # 取回一个 Skipped Item；下次采集 X 时它会以待分类状态存入
pnpm starsieve publish --store <dir> --out <dir> [--dry-run]
pnpm starsieve check --store <dir>
pnpm starsieve list --store <dir> [--q <words>] [--category <name>] [--source github|x] [--visibility public|private] [--needs-review] [--limit 50]  # 只读搜索
pnpm starsieve site build --store <dir> --out <dir> [--css <local-tools.css>]  # 公开站点：单个 index.html
pnpm starsieve run [--store <dir>] [--public <clone>] [--no-push] [--pr-dry-run] [--dry-run] [--max-batches N]
pnpm starsieve lists sync [--store <dir>] [--public <clone>] [--dry-run]
pnpm starsieve init data --private <clone> --public <clone> [--store <dir>] [--force]
pnpm starsieve init github --dry-run [--repo owner/name]
pnpm starsieve schedule install|uninstall|status
```

每个命令都接受 `--json`；输出带 `schemaVersion`。退出码：0 完成，1 失败，2 用法错误。

## Store 目录结构

store 是一个普通目录，设计上放在一个私有 git 仓库里。每个文件都是 JSON，键按字母排序，两空格缩进，末尾带换行，这样 `git diff` 能保持很小。

| 文件 | 内容 |
| --- | --- |
| `items/github.json` | `{schemaVersion, items}`；Item 按 `id`（`github:<owner>/<repo>`）排序。`collect` 会刷新 Item 字段，但不会删除已经取消 star 的 Item。 |
| `items/x.json` | `{schemaVersion, items}`；X Item 按 `id`（`x:<status id>`）排序，字段有：`signals`（`like`、`bookmark`）、`url`、`author`、`text`、`postedAt`（帖子的发布时间；X 不显示点赞时间）、`collectedAt`、`hasMedia`、`textEmpty`。再次看到同一条帖子时只会补上 Signal（收藏动作），文本保持不变。 |
| `skipped.json` | `{schemaVersion, skipped}`；Skipped Item（跳过的条目）：从 id 到 `{skippedAt}` 的映射。它们的文本已从 `items/x.json` 删除；再次采集到它们时只计为已知。 |
| `backfill.json` | `{schemaVersion, x: {like, bookmark}}`；每个列表最近一次 Backfill 读到的位置：`startedAt`、`updatedAt`、`scrolls`、`seen`、`added`、`earliestPostedAt`、`reachedEnd`、`finished`。 |
| `classifications.json` | `{schemaVersion, classifications}`；从 Item id 到它的 Classification（分类结果）的映射：`category`、`tags`、`summary`、`visibility`、`needsReview`、`locked`、`by`（`classifier`、`owner`，私有仓库的 star 则是 `collector`）、`inputHash`。 |
| `categories.json` | Category Table：`{schemaVersion, categories: [{name, description, nameEn?}]}`。`name` 是 Category 本身，Classifier、分类结果和 `items.json` 都用它；可选的 `nameEn`（单行）只用于展示，出现在英文 README 里，没有它时显示 `name`（`未分类` 显示为 `Uncategorized`）。表里的顺序就是发布出去的 README 里各节的顺序。`categories init` 只在还没有分类表时写入默认表；`categories set --file` 先检查新表再替换（`schemaVersion` 为 1，名称非空且不重复，包含 `未分类`，最多 32 个 Category，这是 GitHub Lists 的上限）。加 `--reclassify` 时，它还会删除所有未锁定的 `classifier` 分类结果，让这些 Item 重新变成待分类；Locked（已锁定）和 `collector` 分类结果以及 Skipped Item 保持不变。Category 已不在表里的 Locked 分类结果会列在 `staleLocked` 中，留给 `override` 处理。 |
| `config.json` | 可选。`{schemaVersion, classifier: {command, timeoutMs}}`：只设置 Classifier；本机设置放在 `~/.config/starsieve/config.json`（见 [配置](#配置)）。 |
| `publish-state.json` | 由 `publish` 写入（`--dry-run` 不写）：上一次 Public Projection（公开投影，即允许公开的 Item 和字段子集）的哈希，以及它的 `contentHash`（不含 star 数），供 `check` 使用。 |
| `owner-kept.json` | `{schemaVersion, kept}`：所有者用 `override --unskip` 取回的 X 帖子，按 id 记录。`apply` 不会再跳过它们。 |
| `heartbeat.json` | 由 `run` 写入：`lastAttemptAt`、`lastSuccessAt`、`result`、`nothingNew` 以及每个步骤的结果。 |
| `.starsieve-write.lock.<pid>.<uuid>` | store 锁的认领文件；只在写入进行中存在（见下文）；`run` 提交 store 时不会把它们带进去。 |

除此之外不写别的文件；`pending` 和失败的 `classify` 不会改动 store。

对 store 的每一次读-改-写（`apply`，包括 `classify` 内部的那次；`override` 和 `override --unskip`，包括从 Panel 发起的；`collect github` 和 `collect x` 的合并步骤）都会持有 store 锁 `.starsieve-write.lock`，最多等待 30 秒让其他进程结束。进程认领锁的方式是创建自己的文件 `<lock>.<pid>.<uuid>`；当那里没有其他存活进程的认领时，它就持有锁。已死进程的认领按确切文件名删除，所以两个进程同时接管同一个过期锁时，不会都拿到它。如果一个认领已超过 10 秒，而它的 pid 现在属于一个比认领晚 10 秒以上启动的进程（pid 被复用，用 `ps -o etime=` 检查），这个认领就算已死。多个认领相遇时，最早的那个继续等，其余的撤回，随机停顿一会儿后重试，所以总有一个能拿到锁。`apply` 在锁内重新读取 `classifications.json`，所以 Classifier 运行期间所有者做的修改会被保留，Locked 条目也永远不会被覆盖。锁只覆盖文件读写，不覆盖 Classifier 或浏览器的运行。

## X 采集

`collect x` 和 `backfill x` 用一段固定脚本驱动 ego-browser（ADR 0003）：每一步是一次 `ego-browser nodejs` 调用，运行在基于 `Default` profile 创建的 task space 上，结束时关闭这个 task space，失败时也会关闭。点赞从 `x.com/i/history/likes` 读取，收藏从 `x.com/i/history` 读取。被重定向到 onboarding 或登录页，或者页面既没有帖子也没有空列表提示，都算错误（退出码 1），不会当成「没有新内容」。`goto` 会重试 3 次。

- `collect x` 从顶部开始读，遇到以下任一情况停止：连续 `--known-stop` 条已知帖子；连续 5 次滚动都没有新内容；达到 `--max-scrolls`。「已知」按列表分别计算：带着该列表 Signal 存下的帖子，或者 Skipped Item（点赞过的帖子在收藏列表里仍算新帖，它会在那里补上收藏 Signal）。每个列表保存一次。
- `backfill x` 不理会已知帖子，每滚动 10 次保存一次，并把读到的位置记进 `backfill.json`。按 Ctrl-C 会在两次滚动之间停下并保存。

X 会截断长帖，所以 `text` 可能只是预览。X Article 本身没有帖子正文；帖子显示 Article 卡片（`article-cover-image`）时，卡片的标题和摘要会成为 `text`（如果帖子有正文，就接在正文后面），所以它不算 `textEmpty`。这项改动之前存下的帖子保留原来的文本。

`override <id> --unskip` 把 id 从 `skipped.json` 移除，并记进 `owner-kept.json`。帖子被跳过时文本已经删除，所以不会立刻恢复别的内容：下一次读到这条帖子的 `collect x` 或 `backfill x` 会把它重新存成一个新的待分类 Item。之后如果 Classifier 对这条所有者取回的帖子回答 `keep: false`，`apply` 不会跳过它，而是保留它并标上 Needs Review（待复核；分类为 `未分类`，除非回答另有说明，否则为 private）。

## Batch 与 apply

`pending` 打印一个只含单一 Source（来源）的 Batch（由 `--source` 指定，否则取最新待分类 Item 的 Source）：`batchId`、`source`，以及每个 Item 的 `id`、`inputHash` 和 Classifier 看到的输入（GitHub：`id`、`name`、`url`、`description`、`language`、`topics`；X：`id`、`source`、`url`、`author`、`text`、`textEmpty`、`hasMedia`、`postedAt`）。`inputHash` 是这份输入的 sha256，所以 star 数变化和新增 Signal 都不会让 Batch 过期。私有仓库的 star 永远不会进入待分类：`collect github` 直接给它们一个 private 的 `collector` 分类结果（分类为 `未分类`），它们永远不会进入 prompt。`batchId` 由 (id, inputHash) 对推导出来，所以不需要存任何状态。

`apply --file` 接收 Batch 加上回答：`{schemaVersion, batchId, items: [{id, inputHash}], classifications: [{id, category, tags, summary, visibility, needsReview}]}`。以下情况会拒绝整个文件：`schemaVersion` 不是 1；`batchId` 与其 `items` 不匹配；没有 Category Table。逐条处理规则：

- id 不在 store 里、不在 Batch 里，或者重复：拒绝。
- Locked：跳过，永不覆盖。
- `inputHash` 与 Item 当前的不同：拒绝。
- category 不在 Category Table 里：保留为 `未分类` 并标 `needsReview`。
- tags 超过 6 个：保留前 6 个。
- summary：先去掉链接和 HTML，再截到 80 个字符（按 code point 计）。
- visibility 缺失或不是 `public`/`private`：取 `private`。
- X Item 没有布尔值 `keep`：拒绝。`keep: false`：它变成 Skipped Item（`status: skippedItem`）；GitHub Item 上的 `keep` 会被忽略。
- 带 `textEmpty` 的 X Item：一律 `private` 并标 `needsReview`。

## Classifier

`classify` 把 Batch 写进 prompt，在一个新建的空临时工作区里运行配置好的命令，再从 stdout 读取一个 JSON 对象。这个工作区的 `.cursor/cli.json` 禁止 `Shell(*)`、`Read(**)` 和 `Write(**)`（ADR 0001）。超时、非零退出码或无法解析的输出都算错误，不会写入任何内容。无法解析时，错误信息只给出输出的长度、它 sha256 的前 12 位十六进制数和失败类型，从不包含原文（原文可能含帖子文本，而错误会进入日志和 Heartbeat）。输出本身保存到 `~/Library/Logs/starsieve/classify-unparsed-*.txt`，只有所有者可读（权限 600），错误信息会给出这个文件名。交给 `apply` 的 `batchId` 和 `inputHash` 由 runner 提供，不由 agent 提供。X 的 prompt 额外加了几条：只保留技术帖子（编程、AI、开发者工具、设计工程）；要求对每条帖子给出 `keep`；告诉 agent 没有文本的帖子要标 `needsReview` 和 `private`。

默认命令如下，可以在 `config.json` 里覆盖：

```json
{
  "schemaVersion": 1,
  "classifier": {
    "command": ["cursor-agent", "-p", "--model", "grok-4.7-medium", "--mode", "ask", "--sandbox", "enabled",
                "--trust", "--workspace", "{workspace}", "--output-format", "text", "{prompt}"],
    "timeoutMs": 900000
  }
}
```

每个参数里的 `{prompt}`、`{workspace}` 和 `{store}` 都会被替换。没有 `{prompt}` 时，prompt 走 stdin。命令以临时工作区为工作目录运行，所以脚本要用绝对路径。

沙箱由 cursor-agent 自己提供：它读取工作区的 `.cursor/cli.json`，starsieve 只负责写这个文件。其他 agent CLI 会忽略这个文件。所以把别的 CLI 填进 `command` 之前，要先通过它的参数或配置给它一个不带任何工具的模式（不能用 shell，不能读写文件）；starsieve 无法检查它是否有这样的模式。`grok-4.7-medium` 只是默认模型：store 的 `config.json` 里的 `command` 会替换整条默认命令，模型也一起替换。

## 发布

`publish` 把 `items.json` 和两份 README 目录（英文 `README.md`、中文 `README.zh-CN.md`）写到 `--out`。内容按 Category 分组，顺序与分类表一致；组内最新 star（或帖子）在前。一个 Item 要被收录，必须有 Visibility（可见性）为 `public` 的分类结果；如果是 star，它的仓库还必须是公开的（`repoPrivate` 为 `false`）。所有者的 override 也不能让私有仓库的 star 变成公开。GitHub Item 还带 `stargazers`；每个 Item 都带 `needsReview` 和 `addedAt`（star 的时间；X 则是 starsieve 第一次看到它的时间）。X Item 发布时只包含 `url`、`author`、`postedAt`、`addedAt`、`category`、`tags`、`summary` 和 `needsReview`，从不包含正文；Skipped Item 永远不发布。只写入白名单里的字段，也不写运行时间戳，所以发布两次得到的文件完全相同。star 数每天都在变，所以单是 star 数变化不算有新内容要发布（`contentHash` 不含 star 数）；只要发布了别的内容，star 数就会一起刷新。`--dry-run` 打印公开 Item 的数量，以及与 `--out` 现有内容的差异，不写任何文件。

两份 README 结构相同：依次是标题、切换到另一种语言的链接、数量统计、在线目录链接、带各 Category 数量的目录，然后每个 Category 一节，每节带一个回到目录的链接。每个 Item 占一个列表项：仓库写成 `[owner/repo](url) — Summary<br><sub>language · Tags</sub>`（Summary 去掉末尾句号；最多 3 个 Tag（标签），保留第一个；第一个 Tag 已经写明语言时，省略 language）；帖子写成 `X · [@author](url) — Summary<br><sub>Tags</sub>`。没有 Summary 时省略破折号；没有 language 和 Tags 时省略第二行。英文版显示各 Category 的 `nameEn`，并说明摘要和标签是中文；中文版全是中文。README 不显示 star 数，所以只有 star 数变化的那天它们保持不变。`~/.config/starsieve/config.json` 里的两个可选键控制它们，`publish` 和 `run` 都会读取：

```json
{ "readme": { "title": { "en": "Tech collection", "zh": "技术收藏" } }, "siteUrl": "https://<owner>.github.io/<repo>/" }
```

`readme.title` 英文默认是 Tech collection，中文默认是 技术收藏；写成一行字符串时两种语言共用。没有 `siteUrl` 时，README 不放在线目录链接；starsieve 从不根据 `publicRepo` 猜这个地址，因为仓库名证明不了 Pages 已开启。

## Panel 与公开站点

同一个页面渲染这两者（`src/panel`）。Panel 是 Local Tools Portal 里 `kind: "panel"` 的那一项：`src/panel/index.ts` 导出 `createPanelHandler({ basePath, allowedHosts, theme, readOnly, lang })`，`/api/health` 返回 `{ app: "starsieve", version }`。它展示 `~/.config/starsieve/config.json` 里 `storePath` 指定的 store 中的全部 Item，可以按 Source、Category 和 Tag 筛选，可以搜索，可以按最近添加或按 star 数排序。编辑操作调用的函数与 `starsieve override` 和 `override --unskip`（「Skipped」标签页）相同；`readOnly` 会隐藏编辑入口并拒绝所有写入。写入还需要页面的 Origin 和该实例专属的 token。

```json
{ "storePath": "~/path/to/stars-private", "portalCss": "~/path/to/local-tools.css" }
```

`portalCss` 是可选的；见下文的 `site build`。

`site build` 只根据 Public Projection（与 `publish` 用的筛选相同）写出 `index.html`。页面只读，数据内联，所以能直接从 `file://` 打开。样式表也是内联的：设置了 `--css` 或 `portalCss` 时用 Portal 的 `local-tools.css`，否则用 `src/site/default.css`，它是前者的精简副本（只含页面用到的 token 和 `.lt-*` 组件）。所以站点不依赖 Portal 也能构建；只有 Panel 需要 Portal。站点支持按最近添加或按 star 数排序，并给待复核的 Item 标上「待确认」。

## 每日 run

`run` 就是整条流水线，各步骤依次执行；每一步的结果写进 `heartbeat.json` 和日志 `~/Library/Logs/starsieve/run-YYYYMMDD.log`。同一时间只能有一个 run（锁 `run.lock` 放在日志旁边，获取方式与下文的 store 锁相同，最多尝试 1 秒：进程已经不在的 run 会被接管）。`--store` 和 `--public` 默认取 `~/.config/starsieve/config.json` 里的 `storePath` 和 `publicRepoPath`。

1. `check`：检查 store、store 所在的私有仓库和公开克隆。store 不能位于公开克隆内部，store 所在的仓库不能就是公开克隆，store 的 `origin` URL（fetch 和 push 都算，包括 `pushurl`）都不能指向公开仓库（即与公开克隆某个 `origin` URL 相同，或者等于 `publicRepo` 的 slug，大小写不限）。store 的 JSON 也必须通过 `check`。这一步有任何失败，run 就停止，store 里什么都不会 commit 或 push：Heartbeat 只写进 store；如果 store 位于公开克隆内部，则完全不写（那里的任何文件都可能进入公开提交）。
2. `collect-github`、`collect-x`：失败（包括 X 未登录）会让这次 run 失败，但 run 会继续，只是不发布该 Source：它的公开 Item 保持公开分支上的样子，只移除 store 里已不再公开的那些（改成私有、被跳过、已消失）。配置里设了 `"collectX": false` 时，`collect-x` 为 `skipped`，不采集 X。
3. `classify`：每批 25 个，直到没有待分类 Item，或达到 `--max-batches`（`0`：什么都不分类）。
4. `publish`、`site`：在公开克隆的 `starsieve/YYYYMMDD` 分支上（会复用已打开的 starsieve PR 的分支，或尚未 push 的本地分支）写 `data/items.json`、`README.md`、`README.zh-CN.md` 和 `docs/index.html`。只有 star 数变化时什么都不写。
5. `private`：提交 store（Heartbeat 在最后提交）并 push。
6. `public`：提交分支并 push。push 之前，还没有任何远端见过的提交（来自之前 `--no-push` 的运行，多于一个时）会被压成一个提交，内容是当前的投影，放在 base 之上，或放在已 push 的分支之上。这样，本地发布过又在 push 前撤回的 Item 永远不会到达 GitHub。以下情况这一步会失败，分支保持原样，什么都不 push：这些提交改了 `data/`、`README.md`、`README.zh-CN.md` 和 `docs/` 以外的文件（压缩会丢掉这些改动）；本地分支和已 push 的分支已经分叉。这时先手动理顺分支，再重新运行。已经 push 的内容撤不回来：分支 push 之后才改成私有的 Item 会留在该分支的历史里（PR 是 squash 合并的，所以不会进 main 的历史）。
7. `pr`：`gh pr create` 和 `gh pr merge --auto --squash`（配置里的 `publicRepo` 指定仓库）。只复用所有者自己打开（`--author @me`）、来自公开仓库本身分支的已打开 PR，从不复用 fork 的 PR。开启自动合并之前，PR 的 head 必须是这次 run push 的提交（`gh pr view --json headRefOid`），合并时也带上 `--match-head-commit` 指定这个提交；否则这一步失败，什么都不合并。
8. `wait-merge`：轮询 PR，最长 `mergeTimeoutMs`（20 分钟）；超时不算失败。
9. `lists-sync`：见下文；它基于 main 当前的内容运行，所以超时后才合并的 PR 会由下一次 run 同步。
10. `heartbeat`：写入结果，commit 并 push（只在整个 `check` 步骤通过后才做；见第 1 步）。如果没有采集、分类或发布任何新内容，这就是唯一的改动，run 报告「nothing new」。

`--no-push` 在两个克隆里都只做本地 commit，什么都不 push；`--pr-dry-run` 两边都 push，但只打印 PR 命令。用这两个参数之一，或用 `--dry-run`（只打印计划）时，Lists 只做规划。任何失败都以退出码 1 结束。

失败之后，公开克隆会切回原来所在的分支。run 自己产生的未提交文件中，只有内容仍与 run 写入时完全一致的才会撤销；提交留在当天的分支上。克隆里的其他改动（所有者在此期间做的编辑，即使改的是 run 写过的文件）都会保留，`restore-public` 步骤会失败并列出它们；如果保留的改动让 git 无法切回原分支，克隆就停在当天的分支上。

已知限制（已接受；公开克隆是生成出来的，不打算手动编辑）：

- 回滚会在恢复每个文件之前检查它，但在检查和写入之间的那一瞬间，如果另一个进程保存或暂存了这个文件，那次保存仍可能丢失。git 没有针对工作区的 compare-and-swap（先比较再写入的原子操作），无法堵上这个缺口。
- 如果一个锁认领的 pid 在认领后约 2 秒内被一个长期运行的进程复用，这个认领不会被识别为已死（`ps` 报告的启动时间以整秒为单位）。于是写入方会一直等待并以 `LockedError` 失败，直到那个进程退出；这时请手动删除过期的 `<lock>.<pid>.<uuid>` 文件。
- 公开克隆里变成符号链接的文件永远不会回滚；它会被列为保留。

## GitHub Lists

`lists sync` 用 `gh api graphql` 读取每个列表及其成员（`viewer.lists`，读全部分页；任何一次读取失败都会在写入前停止）。然后它取出公开仓库 main 上、store 仍标为公开的 GitHub Item，把每个 Item 加进以它 Category 命名的列表。对含有 GitHub Item 的 Category，缺少的列表用 `createUserList` 创建；列表数超过 32 个时，它在写入前报错停止。`updateUserListsForItem` 会替换一个仓库的全部列表归属，所以每次发送的都是该仓库当前所在的列表加上 Category 对应的列表：从不移除任何归属。每次修改请求（最多 20 个仓库）之前都会重新读取列表，归属以这次读取为准，所以所有者在规划之后才加进某个列表的仓库会被保留。这只是把竞争窗口缩小到一次请求，并没有消除它。`--dry-run` 打印计划。

## 数据仓库与定时任务

`init data` 写入以下文件，但不 push：

- 公开仓库：`.github/workflows/check.yml`（job `check`，在指向 main 的 PR 上运行）和 `.github/scripts/validate.mjs`。后者是一个零依赖的检查脚本，检查 `data/items.json`（schemaVersion、只含白名单字段、不含 Visibility、私有仓库标记或 X 正文、Summary 长度）和改动的路径（只允许 `data/`、`README.md`、`README.zh-CN.md`、`docs/`）。CI 运行的是 base 分支上的那份脚本。
- 私有仓库：`.github/workflows/heartbeat.yml`，每 6 小时运行一次，以及 `.github/scripts/heartbeat-check.mjs`：`lastSuccessAt` 超过 48 小时时开一个 issue（同一时间只开一个），下次成功后关闭。

`init github --dry-run` 打印针对公开仓库的 `gh api` 命令：自动合并、要求 `check` 的 main 分支保护、从 main 的 `/docs` 提供 Pages。

`schedule install` 写入 `~/Library/LaunchAgents/io.github.starsieve.plist`（每天 08:17，加载时不运行，使用登录 shell 的 PATH，日志在 `~/Library/Logs/starsieve/`），并用 `launchctl bootstrap` 加载。如果旧标签 `com.adonis.starsieve` 下还留着任务，会先 boot out 它并删除它的 plist；`schedule status` 和 `schedule uninstall` 也能找到它。在配置里的 `schedulePush` 为 `true` 之前，它的命令带 `--no-push`，并带上取自 `scheduleMaxBatches` 的 `--max-batches`；改了其中任何一个都要重新安装。

## Agent Skill

`skills/starsieve/SKILL.md` 是这个 CLI 的 Agent Skill。它只负责把自然语言请求转成带 `--json` 的 `starsieve` 命令（例如「找一下我 star 过的那个 MCP server」会变成 `list --store <s> --q "mcp server" --json`）；它自己从不读写 store 文件，所以每项能力都要先有 CLI 命令。它的 `metadata.version` 跟随 `package.json` 里的 `version`。

## 开发

```sh
pnpm test
```

测试使用 `node:test`。`classify` 的测试运行 `src/testing/fake-agent.js`，不调用真实的 agent CLI。
