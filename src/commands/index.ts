import { start, stop, status, config } from './bot'
import { scan, pr, commit } from './manual'

export const commands = [start, stop, status, config, scan, pr, commit]
