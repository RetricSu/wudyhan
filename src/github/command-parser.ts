/**
 * Command Parser: Extracts and validates bot commands from GitHub comments
 */

export type BotCommand = 'stop' | 'pause' | 'continue' | 'retry' | 'status' | 'help'

export interface ParsedCommand {
  command: BotCommand
  rawCommand: string // The actual text matched (e.g., "abort" maps to "stop")
  mentionedBot: boolean
}

/**
 * Command aliases for better UX
 */
const COMMAND_ALIASES: Record<string, BotCommand> = {
  stop: 'stop',
  abort: 'stop',
  cancel: 'stop',
  pause: 'pause',
  hold: 'pause',
  continue: 'continue',
  resume: 'continue',
  approve: 'continue', // Approve is same as continue
  retry: 'retry',
  restart: 'retry',
  status: 'status',
  help: 'help',
}

export class CommandParser {
  private botMentionPattern = /@bot\b/i
  private commandPattern = new RegExp(`@bot\\s+(${Object.keys(COMMAND_ALIASES).join('|')})\\b`, 'i')

  /**
   * Parse a comment body for bot commands
   * @param text - The comment body text
   * @returns ParsedCommand if found, null otherwise
   */
  parse(text: string): ParsedCommand | null {
    if (!text) return null

    // Check if bot is mentioned
    const hasMention = this.botMentionPattern.test(text)
    if (!hasMention) return null

    // Extract command
    const match = text.match(this.commandPattern)
    if (!match || !match[1]) return null

    const rawCommand = match[1].toLowerCase()
    const command = COMMAND_ALIASES[rawCommand]

    if (!command) return null

    return {
      command,
      rawCommand,
      mentionedBot: true,
    }
  }

  /**
   * Check if a comment contains a bot mention (without requiring a valid command)
   */
  hasBotMention(text: string): boolean {
    return this.botMentionPattern.test(text)
  }

  /**
   * Parse feedback from comment
   * @param text - The comment body text
   * @returns Feedback message if found, null otherwise
   */
  parseFeedback(text: string): string | null {
    if (!text) return null

    // Match: @bot feedback <message>
    const match = text.match(/@bot\s+feedback\s+(.+)/is)
    if (!match || !match[1]) return null

    return match[1].trim()
  }

  /**
   * Get help text for all commands
   */
  getHelpText(): string {
    return `**Available Bot Commands:**

- \`@bot stop\` (or \`abort\`, \`cancel\`) - Stop the current task
- \`@bot pause\` (or \`hold\`) - Pause the current task
- \`@bot continue\` (or \`resume\`, \`approve\`) - Continue/approve the current task
- \`@bot retry\` (or \`restart\`) - Retry a failed task or regenerate code with feedback
- \`@bot status\` - Get current task status
- \`@bot feedback <message>\` - Provide feedback or guidance for code generation
- \`@bot help\` - Show this help message

**Approval Workflow:**
When code generation completes, the bot will post results and wait for your approval:
1. Review the changes
2. Either approve with \`@bot continue\` or \`@bot approve\`
3. Or provide feedback with \`@bot feedback <message>\` then \`@bot retry\`

**Examples:**
\`\`\`
@bot pause
@bot feedback Please use async/await instead of callbacks
@bot retry
@bot approve
@bot status
\`\`\`
`
  }
}
