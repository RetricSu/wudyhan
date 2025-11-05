# GitHub Maintain Bot

A self-hosted GitHub maintenance bot that autonomously monitors assigned issues, performs coding tasks using AI, and submits pull requests. Built with TypeScript and designed for continuous repository maintenance with **robust crash recovery and resumable workflows**.

## ✨ Key Features

- **🤖 Autonomous Issue Processing**: Automatically handles GitHub issues assigned to the bot
- **🔄 Crash Recovery**: Resumes workflows from the last successful step after crashes
- **🔁 Smart Retries**: Exponential backoff with jitter for transient failures
- **💾 Task Persistence**: SQLite-based state management for reliability
- **🎯 Idempotent Operations**: Safe to run multiple times without duplicating work
- **📊 Full Observability**: Detailed logging and GitHub issue updates
- **⚡ Concurrent Processing**: Handle multiple issues simultaneously with worker locks
- **🛡️ Error Handling**: Dead letter queue for permanent failures

## Architecture

The bot uses a **stateful workflow engine** with the following components:

- **Task State Machine**: Each issue → PR job is a persistent task
- **Workflow Steps**: Plan → Branch → Codex Generate → Test → Commit → PR
- **Worker Process**: Claims and executes tasks with atomic locks
- **Retry Manager**: Handles transient failures with exponential backoff
- **SQLite Database**: Stores all task state and checkpoints

📖 [Read the full architecture documentation](./docs/ARCHITECTURE.md)

## Prerequisites

- [Node.js](https://nodejs.org/) (v20 or higher)
- [pnpm](https://pnpm.io/)
- [Codex CLI](https://github.com/openai/codex) (optional, for AI code generation)
- GitHub Personal Access Token with repo permissions

## Installation

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd wudyhan
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

Create a `.env` file in the root directory:

```env
# GitHub Configuration
GITHUB_TOKEN=ghp_your_github_token_here

# Codex AI Configuration (optional)
CODEX_API_KEY=your_codex_api_key_here
CODEX_MAX_STEPS=50                    # Max agent iterations to prevent token drain (default: 50)
CODEX_MAX_EXECUTION_TIME=1800         # Max execution time in seconds (default: 1800 = 30 min)

# Bot Configuration
MAX_CONCURRENT=3
MAX_RETRIES=5
POLL_INTERVAL=10000
LOG_LEVEL=info
```

### 4. Build the project

```bash
pnpm build
```

### Script Commands

This starter comes with several predefined scripts to help with development:

- `pnpm build` - Build the project using `tsup`.
- `pnpm build:watch` - Automatically rebuild the project on file changes.
- `pnpm commit` - run `commitizen` tool for helping with commit messages.
- `pnpm commitlint` - lint commit messages.
- `pnpm compile` - Compile TypeScript files using `tsc`.
- `pnpm clean` - Remove compiled code from the `dist/` directory.
- `pnpm format` - Check files for code style issues using Prettier.
- `pnpm format:fix` - Automatically fix code formatting issues with Prettier.
- `pnpm lint` - Check code for style issues with ESLint.
- `pnpm lint:fix` - Automatically fix code style issues with ESLint.
- `pnpm start [command]` - Run the CLI application using `ts-node`.
- `pnpm start:node [command]` - Run the CLI application from the `dist/` directory.
- `pnpm test` - Run unit tests.
- `pnpm test:watch` - Run tests and watch for file changes.

## CI/CD and Automation

### Automated Version Management and NPM Publishing with Semantic-Release

This project utilizes `semantic-release` to automate version management and the NPM publishing
process. `Semantic-release` automates the workflow of releasing new versions, including the generation of detailed
release notes based on commit messages that follow the conventional commit format.

## Usage

### Start the Bot

Run the bot in development mode:

```bash
pnpm start run
```

Or in production:

```bash
node dist/run.js run
```

The bot will:

1. Scan for assigned GitHub issues every 60 seconds (configurable)
2. Create tasks for new issues
3. Execute tasks through the workflow pipeline
4. Post status updates to issues
5. Create pull requests when ready

### CLI Commands

#### Monitor Tasks

```bash
# List all tasks
pnpm start tasks

# Filter by state
pnpm start tasks --state=pending
pnpm start tasks --state=in_progress
pnpm start tasks --state=completed
pnpm start tasks --state=failed
pnpm start tasks --state=dead_letter

# Show task details
pnpm start task-status <task-id>

# View task logs
pnpm start task-logs <task-id>
```

#### Manual Operations

```bash
# Manually scan for issues
pnpm start scan

# Retry a failed task
pnpm start task-retry <task-id>

# Check bot status
pnpm start status
```

### Configuration

Create or edit `.env`:

```env
# Required: GitHub Personal Access Token
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx

# Optional: Codex API Key
CODEX_API_KEY=sk-xxxxxxxxxxxxx

# Bot Settings (defaults shown)
MAX_CONCURRENT=3              # Max concurrent tasks
MAX_RETRIES=5                 # Max retry attempts
POLL_INTERVAL=10000           # Worker poll interval (ms)
SCAN_INTERVAL=60000           # Issue scan interval (ms)
LOCK_LEASE_DURATION=300000    # Task lock duration (ms)
LOG_LEVEL=info                # debug | info | warn | error
```

## Command System (Phase 2)

You can control bot tasks directly from GitHub issue comments! Just mention `@bot` with a command:

### Available Commands

#### 🛑 Stop a Task

```
@bot stop
```

Aliases: `@bot abort`, `@bot cancel`

Immediately stops the current task and marks it as failed.

#### ⏸️ Pause a Task

```
@bot pause
```

Aliases: `@bot hold`

Pauses the task execution. The task will pause at the next workflow step.

#### ▶️ Continue a Task

```
@bot continue
```

Aliases: `@bot resume`

Resumes a paused task. The workflow will continue from where it was paused.

#### 🔄 Retry a Task

```
@bot retry
```

Aliases: `@bot restart`

Retries a failed or dead-letter task. The task is reset to pending state.

#### � Provide Feedback

```
@bot feedback <your message>
```

Provide guidance, suggestions, or corrections to help the bot improve its work.

**When to use:**

- Before the task starts - provide context or constraints
- After stopping a task - explain what went wrong and how to fix it

**Examples:**

```
@bot feedback Please use TypeScript strict mode
@bot feedback Add error handling for network timeouts
@bot feedback Follow the coding style in src/utils/example.ts
@bot feedback The authentication should use OAuth2, not basic auth
```

**How it works:**

- All feedbacks are collected from issue comments
- When starting a new Codex job, all feedbacks are injected into the AI prompt
- The AI takes your suggestions into account when generating code
- Feedbacks persist in the issue - no need to repeat them

**Best workflow:**

```
1. Task runs and generates code
2. You notice an issue: @bot stop
3. Add guidance: @bot feedback Use async/await instead of callbacks
4. Restart: @bot retry
5. Bot reads your feedback and regenerates code with your guidance
```

#### �📊 Get Task Status

```
@bot status
```

Displays the current status of the task, including:

- Current state (pending, in_progress, completed, failed)
- Current workflow step
- Retry count
- Any errors

#### ℹ️ Get Help

```
@bot help
```

Shows all available commands and their usage.

### Command Permissions

Only the following users can control tasks via comments:

- **Issue assignees** - Users assigned to the issue
- **Repository owner** - The owner of the repository
- **Issue author** - The user who created the issue

### Command Monitoring

The bot polls for new commands every 30 seconds. When a command is detected:

1. ✅ Command is parsed and validated
2. 🔐 Permissions are checked
3. ⚙️ Command is executed
4. 💬 Result is posted as a comment reply

All command executions are logged in the database for audit purposes.

## How It Works

### Workflow Steps

Each task goes through these steps:

1. **Plan** 📋

   - Analyzes the issue content
   - Creates a task plan
   - Determines if issue can be handled automatically

2. **Branch** 🌿

   - Creates deterministic branch: `bot/issue-<num>/<fingerprint>`
   - Idempotent: reuses branch if exists

3. **Codex Generate** 🤖

   - Runs codex to generate code changes
   - Saves job ID for resumability
   - Polls status until completion

4. **Run Tests** 🧪

   - Executes test suite
   - Validates changes

5. **Commit & Push** 📤

   - Commits changes with descriptive message
   - Pushes to remote branch
   - Idempotent: detects if already pushed

6. **Create PR** 🔀
   - Creates pull request
   - Links to original issue
   - Idempotent: reuses existing PR if found

### Crash Recovery

When the bot crashes:

```
Task: in_progress, currentStep: codex_generate, codexJobId: abc123
        ↓
   [Bot crashes]
        ↓
   [Bot restarts]
        ↓
Worker claims task with expired lock
        ↓
Resumes from currentStep (codex_generate)
        ↓
Polls codex status abc123
        ↓
Continues workflow
```

### Retry Logic

Failed steps are retried with exponential backoff:

```
Attempt 1: Wait 1s
Attempt 2: Wait 2s
Attempt 3: Wait 4s
Attempt 4: Wait 8s
Attempt 5: Wait 16s
After 5 attempts: Move to dead_letter queue
```

Only transient errors are retried:

- Network timeouts
- Rate limiting (429)
- Server errors (502, 503, 504)
- Codex temporary failures

Permanent errors go directly to dead letter:

- Authentication errors (401, 403)
- Not found (404)
- Validation errors (400, 422)

## Database

Tasks and logs are stored in `./data/tasks.db` (SQLite).

### Inspect Database

```bash
# Install sqlite3
brew install sqlite3  # macOS
sudo apt install sqlite3  # Linux

# Query tasks
sqlite3 ./data/tasks.db "SELECT id, state, current_step, retry_count FROM tasks;"

# Query logs
sqlite3 ./data/tasks.db "SELECT * FROM task_logs WHERE task_id='<task-id>' ORDER BY created_at DESC LIMIT 10;"
```

### Reset Database

```bash
# WARNING: Deletes all task history
rm -rf ./data/tasks.db
```

## Development

### Project Structure

```
src/
├── core/
│   ├── bot.ts              # Main bot (scanner + worker coordinator)
│   ├── database.ts         # SQLite setup and migrations
│   ├── task.ts             # Task model and types
│   ├── task-store.ts       # Task persistence layer
│   ├── retry-manager.ts    # Retry logic with backoff
│   ├── workflow-steps.ts   # Individual workflow step implementations
│   ├── workflow-engine.ts  # Step orchestration
│   ├── worker.ts           # Worker process
│   └── types.ts            # Core types
├── ai/
│   └── codex.ts            # Codex AI client
├── github/
│   ├── client.ts           # GitHub API client
│   └── issues.ts           # Issue manager
└── workspace/
    └── manager.ts          # Git/workspace operations
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test -- --coverage
```

### Code Quality

```bash
# Lint code
pnpm lint

# Fix linting issues
pnpm lint:fix

# Format code
pnpm format

# Check formatting
pnpm format:fix
```

### Commit Messages

We use conventional commits:

```bash
# Interactive commit helper
pnpm commit

# Manual format
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update README"
```

## Troubleshooting

### Bot not processing issues

1. Check GitHub token permissions
2. Verify issues are assigned to the bot user
3. Check logs: `pnpm start --log-level debug`
4. Inspect database: `pnpm start tasks`

### Tasks stuck in `in_progress`

Tasks with expired locks are auto-recovered:

```bash
# Check for stuck tasks
pnpm start tasks --state=in_progress

# Wait 5 minutes for lock to expire, or manually reset
sqlite3 ./data/tasks.db "UPDATE tasks SET state='pending', worker_id=NULL, lock_expires_at=NULL WHERE id='<task-id>';"
```

### Codex failures

1. Verify CODEX_API_KEY is set
2. Check codex CLI is installed: `which codex`
3. Test codex manually: `codex exec "test prompt"`

### Dead letter queue growing

View failed tasks:

```bash
pnpm start tasks --state=dead_letter
pnpm start task-logs <task-id>
```

Common causes:

- Authentication errors (fix GitHub token)
- Invalid issue format (update issue)
- Persistent codex failures (check codex config)

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Use conventional commit messages
5. Submit a pull request

## Documentation

- [Architecture Guide](./docs/ARCHITECTURE.md) - Detailed architecture documentation
- [Refactoring Summary](./docs/REFACTORING_SUMMARY.md) - What changed and why

---

**Built with 🤖 by the GitHub Maintain Bot team**
