import * as info from './info'
import * as greeting from './greeting'
import * as create from './create'
import { start, stop, status, config } from './bot'

export const commands = [info, greeting, create, start, stop, status, config]
