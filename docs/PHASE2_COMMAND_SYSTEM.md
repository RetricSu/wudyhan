# Phase 2: Command System via Comments - 实现文档

**创建时间**: 2025-11-05  
**状态**: 待实现  
**优先级**: 中等

## 📋 概述

通过 GitHub Issue 评论实现对 bot 的实时控制，允许用户通过 @mention 命令来暂停、继续、中止或查询任务状态。

## 🎯 目标

1. 用户可以通过评论控制正在执行的任务
2. 支持暂停、继续、中止、重试、查询状态等操作
3. 只有授权用户（issue assignee/author）可以执行命令
4. Bot 自动回复命令执行结果
5. 记录所有命令历史用于审计

## 🏗️ 架构设计

### 系统流程图

```
┌─────────────────────────────────────────────────────────┐
│                   GitHub Issue                          │
│  User: @bot stop     ← 用户在 issue 中发评论            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              CommentMonitor (新增)                      │
│  - 定期拉取新评论（每 30 秒）                            │
│  - 解析 @bot 命令                                       │
│  - 过滤已处理的评论                                      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              CommandParser (新增)                        │
│  - 解析命令类型和参数                                    │
│  - 验证命令权限（仅 issue assignee/author）              │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              CommandExecutor (新增)                      │
│  - 执行命令（stop/continue/retry/status）               │
│  - 更新任务状态                                         │
│  - 回复执行结果                                         │
└─────────────────────────────────────────────────────────┘
```

## 📝 支持的命令

### 命令列表

| 命令         | 别名   | 格式            | 功能                          | 状态转换                           |
| ------------ | ------ | --------------- | ----------------------------- | ---------------------------------- |
| **stop**     | abort  | `@bot stop`     | 停止当前任务并 kill codex job | `in_progress` → `aborted`          |
| **pause**    | -      | `@bot pause`    | 暂停任务（在下一步执行前）    | `in_progress` → `paused`           |
| **continue** | resume | `@bot continue` | 继续被暂停/中止的任务         | `paused`/`aborted` → `pending`     |
| **retry**    | -      | `@bot retry`    | 重试失败的任务                | `failed`/`dead_letter` → `pending` |
| **status**   | -      | `@bot status`   | 查询当前任务状态和进度        | 无变化                             |
| **help**     | -      | `@bot help`     | 显示所有可用命令              | 无变化                             |

### 命令详细说明

#### 1. @bot stop / @bot abort

**功能**: 立即停止当前任务

- 如果有正在运行的 Codex job，调用 `jobManager.killJob()`
- 将任务状态设置为 `aborted`
- 释放 worker 锁
- 用户可以稍后使用 `@bot continue` 重新启动

**前置条件**:

- 任务状态必须是 `in_progress` 或 `paused`

**回复示例**:

```
🛑 **Task Aborted**

Task has been stopped by @username.

**Previous State:** In Progress (Step: codex_generate)
**Current State:** Aborted
**Codex Job:** Killed (job-id: abc123)

You can restart this task with `@bot continue`.
```

#### 2. @bot pause

**功能**: 优雅暂停任务（完成当前步骤后暂停）

- 设置 `pause_requested = true`
- Worker 在执行下一步之前检测到该标志，自动暂停
- 不会 kill 正在运行的 codex job，让它完成

**前置条件**:

- 任务状态必须是 `in_progress`

**回复示例**:

```
⏸️ **Pause Requested**

Task will pause after the current step completes.

**Current Step:** codex_generate
**Status:** Waiting for step to finish...

Use `@bot continue` to resume later.
```

#### 3. @bot continue / @bot resume

**功能**: 继续暂停或中止的任务

- 将任务状态改为 `pending`
- 重置 `pause_requested = false`
- Worker 会自动拾取并继续执行

**前置条件**:

- 任务状态必须是 `paused` 或 `aborted`

**回复示例**:

```
▶️ **Task Resumed**

Task has been resumed by @username.

**Previous State:** Paused
**Current State:** Pending
**Next Step:** run_tests

The worker will pick up this task shortly.
```

#### 4. @bot retry

**功能**: 重试失败的任务

- 重置 `retry_count = 0`
- 清除 `last_error`
- 将任务状态改为 `pending`
- 从失败的步骤重新开始

**前置条件**:

- 任务状态必须是 `failed` 或 `dead_letter`

**回复示例**:

```
🔄 **Task Retry Scheduled**

Task will be retried from step: codex_generate

**Previous Error:** Codex execution timeout
**Retry Count:** Reset to 0
**State:** Pending

The worker will pick up this task shortly.
```

#### 5. @bot status

**功能**: 查询任务当前状态

- 显示任务状态、当前步骤、进度
- 如果有 codex job，显示 job 状态和进度
- 显示最近的活动日志

**前置条件**: 无

**回复示例**:

```
📊 **Task Status**

**State:** In Progress
**Current Step:** codex_generate (3/6)
**Started:** 5 minutes ago
**Worker:** worker-abc123
**Lock Expires:** in 4 minutes

**Codex Job:**
- Job ID: job-xyz789
- Status: Running
- Progress: "Analyzing codebase and generating fixes..."
- Started: 3 minutes ago

**Workflow Progress:**
- ✅ plan - Completed
- ✅ branch - Completed
- ⏳ codex_generate - In Progress
- ⬜ run_tests - Pending
- ⬜ commit_push - Pending
- ⬜ create_pr - Pending

**Recent Activity:**
- 5 min ago: Task started
- 4 min ago: Plan created (2 tasks identified)
- 3 min ago: Branch created: bot/issue-123/a1b2c3d4
- 3 min ago: Codex job started
```

#### 6. @bot help

**功能**: 显示命令帮助
**前置条件**: 无

**回复示例**:

```
🤖 **Bot Commands Help**

Available commands (mention @bot in a comment):

**Control Commands:**
- `@bot stop` - Stop the current task immediately
- `@bot pause` - Pause after current step completes
- `@bot continue` - Resume a paused/stopped task
- `@bot retry` - Retry a failed task

**Info Commands:**
- `@bot status` - Show current task status and progress
- `@bot help` - Show this help message

**Permissions:**
Only issue assignees and the issue author can execute commands.

**Examples:**
- Stop task: `@bot stop`
- Check status: `@bot status`
- Resume: `@bot continue`
```

## 🗄️ 数据库设计

### 1. 扩展 `tasks` 表

```sql
-- 添加新字段
ALTER TABLE tasks ADD COLUMN command_state TEXT DEFAULT 'running'
  CHECK(command_state IN ('running', 'paused', 'aborted', 'waiting_user'));

ALTER TABLE tasks ADD COLUMN last_comment_check_at TEXT;

ALTER TABLE tasks ADD COLUMN pause_requested INTEGER DEFAULT 0;
```

**字段说明**:

- `command_state`: 命令控制的状态（区别于 `state` 是 workflow 状态）
- `last_comment_check_at`: 最后检查评论的时间戳，用于增量拉取
- `pause_requested`: 布尔标志，表示是否请求暂停（0=false, 1=true）

### 2. 新增 `task_commands` 表

```sql
CREATE TABLE IF NOT EXISTS task_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  command TEXT NOT NULL,
  comment_id INTEGER NOT NULL UNIQUE,  -- 防止重复执行
  comment_author TEXT NOT NULL,
  comment_body TEXT,
  executed_at TEXT NOT NULL,
  result TEXT,  -- 'success' | 'failed' | 'ignored'
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_commands_task_id ON task_commands(task_id);
CREATE INDEX IF NOT EXISTS idx_task_commands_comment_id ON task_commands(comment_id);
CREATE INDEX IF NOT EXISTS idx_task_commands_executed_at ON task_commands(executed_at);
```

**用途**:

- 记录所有执行过的命令历史
- 通过 `comment_id UNIQUE` 防止重复执行
- 用于审计和调试

## 📦 文件结构

### 新增文件

```
src/
  github/
    comment-monitor.ts       # 评论监控服务
    command-parser.ts        # 命令解析器
    command-executor.ts      # 命令执行器
  core/
    command-store.ts         # 命令数据库操作
```

### 修改文件

```
src/
  github/
    client.ts               # 添加 getIssueComments()
  core/
    task.ts                 # 扩展 Task 类型
    task-store.ts           # 添加命令相关查询
    workflow-engine.ts      # 每步检查 pause_requested
    database.ts             # 添加新的 migration
    bot.ts                  # 启动评论监控
```

## 🔄 详细工作流程

### 1. 评论监控流程

```typescript
CommentMonitor (独立定时任务，每 30 秒执行):

1. 获取所有活跃任务（state IN ['pending', 'in_progress', 'paused', 'aborted', 'failed'])

2. 对每个任务:
   a. 从 GitHub API 获取新评论
      - 使用 issue_number 和 last_comment_check_at
      - GET /repos/{owner}/{repo}/issues/{issue}/comments?since={timestamp}

   b. 过滤评论:
      - 包含 @bot 或 @github-bot（配置中的 bot 名称）
      - 评论时间 > last_comment_check_at
      - comment_id 不在 task_commands 表中（未处理过）

   c. 解析每条评论:
      - CommandParser.parse(comment.body) → Command 对象
      - 验证权限: comment.author in [issue.author, ...issue.assignees]

   d. 执行命令:
      - CommandExecutor.execute(command, task)
      - 记录到 task_commands 表
      - 更新任务状态

   e. 回复确认:
      - GitHub.addComment(issue, result_message)

   f. 更新检查时间:
      - taskStore.updateTask(task.id, { last_comment_check_at: now })
```

### 2. Workflow 集成（暂停检查）

```typescript
WorkflowEngine.executeStep():

Before executing each step:
  1. 检查 task.pause_requested

  2. 如果 pause_requested === true:
     - 更新任务状态为 'paused'
     - 设置 command_state = 'paused'
     - 释放 worker 锁
     - 记录日志: "Task paused by user request"
     - 发送 issue 评论通知
     - 返回 { success: false, shouldRetry: false }

  3. 否则继续正常执行
```

### 3. 命令执行流程

```typescript
CommandExecutor.execute(command, task):

根据 command.type:

case 'stop':
  1. 验证状态: task.state IN ['in_progress', 'paused']
  2. 如果有 codex job → jobManager.killJob(task.codexJobId)
  3. taskStore.updateTask(task.id, {
       state: 'aborted',
       command_state: 'aborted',
       worker_id: null,
       lock_expires_at: null
     })
  4. 返回成功消息

case 'pause':
  1. 验证状态: task.state === 'in_progress'
  2. taskStore.updateTask(task.id, { pause_requested: true })
  3. 返回 "将在当前步骤完成后暂停"

case 'continue':
  1. 验证状态: task.state IN ['paused', 'aborted']
  2. taskStore.updateTask(task.id, {
       state: 'pending',
       command_state: 'running',
       pause_requested: false,
       worker_id: null,
       lock_expires_at: null
     })
  3. 返回成功消息

case 'retry':
  1. 验证状态: task.state IN ['failed', 'dead_letter']
  2. taskStore.updateTask(task.id, {
       state: 'pending',
       retry_count: 0,
       last_error: null,
       next_retry_at: null
     })
  3. 返回成功消息

case 'status':
  1. 收集任务信息
  2. 如果有 codex job → jobManager.getJobStatus()
  3. 从 task_logs 获取最近活动
  4. 格式化并返回状态信息
```

## 🔐 安全和权限

### 权限验证

```typescript
function hasPermission(comment: Comment, issue: Issue): boolean {
  const author = comment.author.login

  // Issue 作者
  if (author === issue.author.login) return true

  // Issue assignees
  if (issue.assignees.some((a) => a.login === author)) return true

  // 仓库管理员（可选，通过 GitHub API 检查）
  // if (await isRepoAdmin(author)) return true

  return false
}
```

### 防重复执行

```typescript
// 使用 comment_id 作为唯一键
async function isCommandProcessed(commentId: number): Promise<boolean> {
  const existing = await commandStore.getByCommentId(commentId)
  return existing !== null
}
```

### 速率限制

```typescript
// 每个任务每分钟最多 5 条命令
const RATE_LIMIT = 5
const RATE_WINDOW = 60 * 1000 // 1 minute

async function checkRateLimit(taskId: string): Promise<boolean> {
  const recentCommands = await commandStore.getRecentCommands(taskId, Date.now() - RATE_WINDOW)
  return recentCommands.length < RATE_LIMIT
}
```

## 🚀 实施步骤

### Step 1: 数据库扩展

**文件**: `src/core/database.ts`

- [ ] 添加 `migration_v3()` 方法
- [ ] 扩展 `tasks` 表字段
- [ ] 创建 `task_commands` 表
- [ ] 创建索引

### Step 2: 类型定义扩展

**文件**: `src/core/task.ts`, `src/core/types.ts`

- [ ] 扩展 `Task` 接口添加新字段
- [ ] 定义 `Command` 类型
- [ ] 定义 `TaskCommand` 类型
- [ ] 定义 `CommandResult` 类型

### Step 3: GitHub API 扩展

**文件**: `src/github/client.ts`

- [ ] 实现 `getIssueComments(owner, repo, issueNumber, since?)`
- [ ] 实现 `getIssueComment(owner, repo, commentId)`
- [ ] 添加分页支持

### Step 4: 命令存储

**文件**: `src/core/command-store.ts`

- [ ] 实现 `CommandStore` 类
- [ ] CRUD 操作：create, getByCommentId, getRecentCommands
- [ ] 查询方法：getCommandHistory, getLastCommand

### Step 5: 命令解析器

**文件**: `src/github/command-parser.ts`

- [ ] 实现 `CommandParser` 类
- [ ] 解析 @bot 命令
- [ ] 支持别名（stop/abort, continue/resume）
- [ ] 验证命令格式
- [ ] 单元测试

### Step 6: 命令执行器

**文件**: `src/github/command-executor.ts`

- [ ] 实现 `CommandExecutor` 类
- [ ] 实现各命令处理逻辑
- [ ] 权限验证
- [ ] 生成回复消息
- [ ] 单元测试

### Step 7: 评论监控服务

**文件**: `src/github/comment-monitor.ts`

- [ ] 实现 `CommentMonitor` 类
- [ ] 定时任务（每 30 秒）
- [ ] 拉取和过滤评论
- [ ] 调用 parser 和 executor
- [ ] 错误处理和重试

### Step 8: 集成到 WorkflowEngine

**文件**: `src/core/workflow-engine.ts`

- [ ] 在 `executeStep()` 前检查 `pause_requested`
- [ ] 处理暂停逻辑
- [ ] 添加日志记录

### Step 9: 集成到 Bot

**文件**: `src/core/bot.ts`

- [ ] 初始化 `CommentMonitor`
- [ ] 在 `start()` 中启动监控
- [ ] 在 `stop()` 中停止监控
- [ ] 配置选项（监控间隔等）

### Step 10: 测试和文档

- [ ] 单元测试（parser, executor）
- [ ] 集成测试（端到端流程）
- [ ] 更新 README.md
- [ ] 添加使用示例

## ⚙️ 配置选项

### 环境变量

```env
# Comment Monitoring
COMMENT_MONITOR_INTERVAL=30000        # 评论检查间隔（毫秒，默认 30 秒）
COMMENT_MONITOR_ENABLED=true          # 是否启用评论监控
BOT_MENTION_NAME=bot                  # Bot 提及名称（@bot）
COMMAND_RATE_LIMIT=5                  # 每分钟最多命令数
```

### BotConfig 扩展

```typescript
interface BotConfig {
  // ... 现有字段

  // 新增
  commentMonitor?: {
    enabled: boolean
    interval: number // 毫秒
    mentionName: string // 默认 "bot"
    rateLimit: number // 每分钟最多命令数
  }
}
```

## 📊 监控指标

建议添加的指标：

```typescript
// 命令执行统计
- total_commands_executed
- commands_by_type (stop, pause, continue, retry, status)
- failed_commands
- permission_denied_commands

// 性能指标
- comment_check_duration
- command_execution_duration
- github_api_calls

// 任务状态
- tasks_paused_by_user
- tasks_aborted_by_user
- tasks_resumed_by_user
```

## 🧪 测试计划

### 单元测试

1. **CommandParser 测试**

   - 解析各种命令格式
   - 处理别名
   - 处理无效命令
   - 提取命令参数

2. **CommandExecutor 测试**

   - 各命令的执行逻辑
   - 状态转换验证
   - 权限检查
   - 错误处理

3. **CommandStore 测试**
   - CRUD 操作
   - 去重逻辑
   - 查询方法

### 集成测试

1. **端到端流程**

   - 创建 mock issue 和 comments
   - 监控器拉取评论
   - 解析并执行命令
   - 验证任务状态变化
   - 验证回复评论

2. **并发测试**
   - 同时多个命令
   - 命令冲突处理
   - 速率限制

## 📝 API 设计

### CommandParser

```typescript
interface Command {
  type: 'stop' | 'pause' | 'continue' | 'retry' | 'status' | 'help'
  args?: Record<string, any>
  raw: string
}

class CommandParser {
  parse(text: string): Command | null
  extractMentions(text: string): string[]
  isValidCommand(text: string): boolean
}
```

### CommandExecutor

```typescript
interface CommandResult {
  success: boolean
  message: string
  error?: string
  taskUpdates?: Partial<Task>
}

class CommandExecutor {
  constructor(taskStore: TaskStore, jobManager: CodexJobManager, issueManager: IssueManager)

  async execute(command: Command, task: Task, comment: Comment, issue: Issue): Promise<CommandResult>

  private async executeStop(task: Task): Promise<CommandResult>
  private async executePause(task: Task): Promise<CommandResult>
  private async executeContinue(task: Task): Promise<CommandResult>
  private async executeRetry(task: Task): Promise<CommandResult>
  private async executeStatus(task: Task): Promise<CommandResult>
  private async executeHelp(): Promise<CommandResult>

  hasPermission(comment: Comment, issue: Issue): boolean
}
```

### CommentMonitor

```typescript
interface CommentMonitorConfig {
  interval: number
  enabled: boolean
  mentionName: string
  rateLimit: number
}

class CommentMonitor {
  constructor(
    config: CommentMonitorConfig,
    taskStore: TaskStore,
    commandStore: CommandStore,
    githubClient: GitHubClient,
    parser: CommandParser,
    executor: CommandExecutor,
  )

  start(): void
  stop(): void
  private async checkComments(): Promise<void>
  private async processComment(comment: Comment, task: Task, issue: Issue): Promise<void>
}
```

### CommandStore

```typescript
interface TaskCommand {
  id: number
  taskId: string
  command: string
  commentId: number
  commentAuthor: string
  commentBody?: string
  executedAt: string
  result: 'success' | 'failed' | 'ignored'
  error?: string
}

class CommandStore {
  constructor(db: TaskDatabase)

  create(command: Omit<TaskCommand, 'id'>): TaskCommand
  getByCommentId(commentId: number): TaskCommand | null
  getByTaskId(taskId: string): TaskCommand[]
  getRecentCommands(taskId: string, since: number): TaskCommand[]
  getCommandHistory(taskId: string, limit?: number): TaskCommand[]
}
```

## 🎯 成功指标

实现完成后，应达到：

1. ✅ 用户可以通过评论控制任务（stop/pause/continue/retry/status）
2. ✅ 权限控制生效（只有 assignee 和 author 可执行）
3. ✅ 命令去重（同一评论不会重复执行）
4. ✅ Bot 自动回复命令结果
5. ✅ 所有命令都有历史记录
6. ✅ 暂停功能正常工作（不丢失进度）
7. ✅ 测试覆盖率 > 80%
8. ✅ 文档完整（README + 代码注释）

## 📚 参考资料

- GitHub API: [Issue Comments](https://docs.github.com/en/rest/issues/comments)
- Rate Limiting: [GitHub API Rate Limits](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)
- Mentions: [GitHub Mention Syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#mentioning-people-and-teams)

## 🔄 未来改进

Phase 3+ 可能的功能：

1. **Webhook 支持**: 使用 GitHub Webhooks 代替轮询，实时响应评论
2. **更多命令**: `@bot logs`, `@bot config`, `@bot skip-step` 等
3. **Issue 标签管理**: 自动添加/移除标签（`bot:working`, `bot:paused` 等）
4. **进度通知**: 定期在 issue 中更新进度
5. **多任务支持**: 一个 issue 可以有多个并行任务
6. **命令队列**: 支持批量命令或条件命令

---

**文档版本**: v1.0  
**最后更新**: 2025-11-05  
**维护者**: GitHub Copilot + User
