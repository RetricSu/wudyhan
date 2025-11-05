/**
 * SQLite database setup and migrations
 */

import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import consola from 'consola'

export class TaskDatabase {
  private db: Database.Database

  constructor(dbPath: string = './data/tasks.db') {
    // Ensure directory exists
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL') // Better concurrency
    this.db.pragma('foreign_keys = ON')

    this.migrate()
  }

  private migrate(): void {
    const currentVersion = this.getCurrentVersion()
    consola.info(`Current database version: ${currentVersion}`)

    const migrations = [this.migration_v1, this.migration_v2, this.migration_v3]

    for (let i = currentVersion; i < migrations.length; i++) {
      consola.info(`Running migration ${i + 1}...`)
      const migration = migrations[i]
      if (migration) {
        migration.call(this)
      }
      this.setVersion(i + 1)
    }

    consola.success('Database migrations completed')
  }

  private getCurrentVersion(): number {
    try {
      const result = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      return result.user_version
    } catch {
      return 0
    }
  }

  private setVersion(version: number): void {
    this.db.pragma(`user_version = ${version}`)
  }

  /**
   * Migration v1: Create tasks table
   */
  private migration_v1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        repo_head_sha TEXT NOT NULL,
        fingerprint TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'in_progress', 'completed', 'failed', 'dead_letter')),
        current_step TEXT,
        checkpoints TEXT NOT NULL DEFAULT '{}',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        next_retry_at TEXT,
        last_error TEXT,
        worker_id TEXT,
        lock_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_fingerprint ON tasks(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_tasks_repo_issue ON tasks(repo, issue_number);
      CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_lock_expires ON tasks(lock_expires_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_next_retry ON tasks(next_retry_at);
    `)
  }

  /**
   * Migration v2: Create task logs table for debugging
   */
  private migration_v2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_logs_created_at ON task_logs(created_at);
    `)
  }

  /**
   * Migration v3: Add command system support
   */
  private migration_v3(): void {
    // Add new fields to tasks table for command system
    this.db.exec(`
      -- Add command_state to track pause/stop states
      ALTER TABLE tasks ADD COLUMN command_state TEXT DEFAULT NULL 
        CHECK(command_state IS NULL OR command_state IN ('paused', 'stopped'));
      
      -- Add pause_requested flag for workflow engine to check
      ALTER TABLE tasks ADD COLUMN pause_requested INTEGER DEFAULT 0;
      
      -- Add last_comment_check_at for efficient polling
      ALTER TABLE tasks ADD COLUMN last_comment_check_at TEXT DEFAULT NULL;
    `)

    // Create task_commands table for audit trail
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        command TEXT NOT NULL,
        comment_id INTEGER NOT NULL,
        comment_author TEXT NOT NULL,
        comment_body TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('success', 'failed', 'ignored')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_commands_task_id ON task_commands(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_commands_executed_at ON task_commands(executed_at);
      CREATE INDEX IF NOT EXISTS idx_task_commands_comment_id ON task_commands(comment_id);
    `)
  }

  /**
   * Get the raw database connection for advanced queries
   */
  getConnection(): Database.Database {
    return this.db
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close()
  }

  /**
   * Begin a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
}
