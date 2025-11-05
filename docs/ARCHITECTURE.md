# Workflow Architecture Documentation

## Overview

The bot now uses a **robust, resumable workflow architecture** with SQLite-based task persistence. This design ensures that workflows can survive crashes, retry transient failures safely, and avoid redoing work.

## Key Components

### 1. Task State Machine

Each issue → PR job is modeled as a **stateful task** with persistent storage:

```typescript
interface Task {
  id: string
  issueNumber: number
  repo: string
  repoHeadSha: string // SHA when scanned (detects repo changes)
  fingerprint: string // Unique hash for idempotency
  state: 'pending' | 'in_progress' | 'completed' | 'failed' | 'dead_letter'
  currentStep?: WorkflowStep
  checkpoints: TaskCheckpoints // Per-step artifacts
  retryCount: number
  maxRetries: number
  nextRetryAt?: string
  lastError?: string
  workerId?: string // Current worker holding lock
  lockExpiresAt?: string // Lock expiration
  createdAt: string
  updatedAt: string
}
```

### 2. Workflow Steps

The workflow is broken into **small, deterministic steps**:

1. **Plan** - Analyze issue and create task plan
2. **Branch** - Create deterministic branch (idempotent)
3. **Codex Generate** - Run codex to generate code (long-running, resumable)
4. **Run Tests** - Validate changes
5. **Commit and Push** - Commit and push to remote (idempotent)
6. **Create PR** - Create or find existing PR (idempotent)

Each step:

- Writes checkpoints to the database after success
- Can be resumed from any point after a crash
- Is designed to be idempotent (safe to run multiple times)

### 3. Task Persistence (SQLite)

**Database: `./data/tasks.db`**

Tables:

- `tasks` - Main task state and checkpoints
- `task_logs` - Detailed logs for debugging

The `TaskStore` class provides:

- CRUD operations for tasks
- Atomic lock acquisition/renewal
- Checkpoint management
- Retry scheduling

### 4. Worker Process

The `Worker` class:

- Polls for pending tasks every 10 seconds
- Claims tasks using atomic database locks (5-minute lease)
- Renews locks every minute while executing
- Handles up to 3 concurrent tasks (configurable)
- Automatically recovers stuck tasks with expired locks

### 5. Workflow Engine

The `WorkflowEngine`:

- Orchestrates step execution
- Resumes from the last successful step after crashes
- Handles errors and schedules retries
- Posts status updates to GitHub issues

### 6. Retry Manager

Implements **exponential backoff** with jitter:

- Base delay: 1 second
- Max delay: 60 seconds
- Max retries: 5 (configurable)
- Only retries transient errors (network, rate limits, timeouts)
- Non-retryable errors go directly to dead letter queue

## Idempotency & Memory

### Fingerprinting

Tasks use a fingerprint: `hash(issueNumber + issueBodySha + repoHeadSha)`

- Prevents duplicate tasks for the same issue state
- If issue or repo changes, new task is created
- Completed tasks are not re-queued unless fingerprint changes

### Deterministic Branch Names

Format: `bot/issue-<number>/<fingerprint-prefix>`

Example: `bot/issue-123/a1b2c3d4`

- Same issue always generates the same branch name
- Safe to re-create if it already exists

### PR Creation

Before creating a PR:

1. Check if branch already has an open PR
2. If yes, reuse it and mark task completed
3. If no, create new PR

## Crash Recovery

### Scenario: Worker crashes mid-execution

1. Task remains in `in_progress` state with an active lock
2. Lock expires after 5 minutes (configurable)
3. Another worker (or restarted worker) claims the expired task
4. Workflow resumes from `currentStep` using saved `checkpoints`
5. For codex jobs: polls `codex status <jobId>` to check completion

### Scenario: Codex job is running when bot crashes

1. `checkpoints.codex_generate.jobId` is saved before codex starts
2. On resume, worker checks `codex status <jobId>`
3. If completed: moves to next step
4. If failed: retries with backoff
5. If still running: keeps polling

## Observability

### Task Logs

Every step logs to `task_logs` table:

```sql
SELECT * FROM task_logs WHERE task_id = '<task_id>' ORDER BY created_at DESC;
```

### CLI Commands

```bash
# View all tasks
pnpm start tasks

# View task details
pnpm start task-status <task-id>

# Retry a failed task
pnpm start task-retry <task-id>

# View task logs
pnpm start task-logs <task-id>

# View dead letter queue
pnpm start tasks --state=dead_letter
```

### GitHub Issue Updates

The bot posts status comments to issues:

- When starting work
- On each step completion
- On retry attempts
- On final success/failure

## Concurrency & Locking

### Worker Locks

- Each task can only be claimed by one worker at a time
- Lock is acquired atomically using SQLite `UPDATE WHERE`
- Lock expires after 5 minutes
- Worker renews lock every 1 minute while executing

### Multiple Workers

You can run multiple workers (e.g., on different machines):

- Each worker has a unique `workerId`
- Workers compete for tasks using database locks
- No Redis or external coordination required

## Configuration

### Bot Config

```typescript
{
  maxConcurrent: 3,        // Max concurrent tasks per worker
  maxRetries: 5,           // Max retry attempts per task
  lockLeaseDuration: 300000, // 5 minutes in ms
  pollInterval: 10000,     // 10 seconds
}
```

### Retry Policy

```typescript
{
  baseDelay: 1000,     // 1 second
  maxDelay: 60000,     // 60 seconds
  jitterFactor: 0.1,   // 10% jitter
}
```

## Testing Recovery

### Test crash recovery:

```bash
# Start bot
pnpm start run

# Kill process mid-execution
# Ctrl+C or kill -9 <pid>

# Restart bot
pnpm start run

# Task resumes from last checkpoint
```

### Test retry logic:

```bash
# Simulate network failure (disconnect network)
# Bot will retry with exponential backoff

# After max retries, task moves to dead_letter
# Check with: pnpm start tasks --state=dead_letter
```

## Migration from Old Architecture

The old bot methods (`checkAndProcessIssues`, `processTask`) are removed. The new flow:

1. **Scanner** (`scanAndQueueIssues`) - Finds issues, creates tasks (idempotent)
2. **Worker** - Claims tasks, executes workflow steps
3. **WorkflowEngine** - Orchestrates step execution, handles retries
4. **TaskStore** - Persists all state to SQLite

Benefits:

- ✅ Resumes after crashes
- ✅ Retries transient failures safely
- ✅ Avoids duplicate work
- ✅ Integrates with codex CLI job tracking
- ✅ Full observability and debugging logs
- ✅ Scales to multiple workers

## File Structure

```
src/core/
  ├── task.ts              # Task model and types
  ├── database.ts          # SQLite database and migrations
  ├── task-store.ts        # Task persistence layer
  ├── retry-manager.ts     # Retry logic with backoff
  ├── workflow-steps.ts    # Individual workflow step implementations
  ├── workflow-engine.ts   # Step orchestration
  ├── worker.ts            # Worker process
  ├── bot.ts               # Main bot (scanner + worker)
  ├── codex-job-store.ts   # [NEW] Codex job persistence
  └── codex-job-manager.ts # [NEW] Async codex execution manager

src/ai/
  └── codex.ts             # [UPDATED] Codex client with job tracking

src/github/
  ├── client.ts            # GitHub API client
  ├── issues.ts            # Issue management
  └── pull-requests.ts     # PR management
```

## Phase 1 Completed: Async Codex Job Management ✅

**Status**: ✅ Implemented (2025-11-05)

### Features

1. **Async Job Execution**

   - Codex runs in background via `spawn()`
   - Non-blocking task execution
   - Real-time stdout/stderr logging

2. **Process Monitoring**

   - Track PID, logs, session ID
   - Check process alive via `process.kill(pid, 0)`
   - Parse JSONL for session metadata

3. **Auto Resume on Crash**

   - Worker startup scans orphaned jobs
   - Automatically resumes via `codex exec resume <session-id>`
   - Preserves work-in-progress

4. **Timeout Protection**

   - Default 30-minute max execution time
   - Configurable via `CODEX_MAX_EXECUTION_TIME`
   - Auto-kill on timeout

5. **Max Steps Control**
   - Limit agent iterations via `--config agent.max_iterations=N`
   - Default 50 iterations
   - Configurable via `CODEX_MAX_STEPS`
   - Prevents token drain

### Database Schema

New `codex_jobs` table:

```sql
CREATE TABLE codex_jobs (
  job_id TEXT PRIMARY KEY,
  session_id TEXT,              -- Codex CLI session UUID
  pid INTEGER,                  -- Process ID
  state TEXT NOT NULL,          -- running | completed | failed | killed | resuming
  prompt TEXT NOT NULL,
  working_dir TEXT,
  options TEXT NOT NULL,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  jsonl_path TEXT,
  exit_code INTEGER,
  error TEXT,
  output TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_heartbeat TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### File Structure

```
data/
  ├── tasks.db                    # Main database
  └── codex-jobs/                 # Job logs
      └── <job-id>/
          ├── stdout.log
          ├── stderr.log
          └── session.jsonl       # Codex session data
```

## Future Enhancements

### Phase 2: Command System via Comments (Planned)

- User control via GitHub issue comments
- Commands: @bot stop, @bot pause, @bot continue, @bot retry, @bot status
- Real-time task control
- See [PHASE2_COMMAND_SYSTEM.md](./PHASE2_COMMAND_SYSTEM.md) for details

### Phase 3+: Additional Features

1. **Advanced Testing**: Add integration tests for crash/recovery scenarios
2. **Monitoring**: Add Prometheus metrics for task states, retry counts, etc.
3. **Multi-repo Support**: Enhanced fingerprinting for cross-repo dependencies
4. **Task Priorities**: Add priority queue for urgent issues
5. **Webhook Support**: Replace polling with GitHub webhooks for real-time updates
