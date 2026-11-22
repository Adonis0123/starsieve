#!/usr/bin/env node
// A stand-in Classifier for tests: `node fake-agent.js <mode> <prompt>`.
// It refuses to run unless its cwd has the deny-all `.cursor/cli.json`, like the real runner sets up.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, prompt = ''] = process.argv.slice(2)

let config
try {
  config = JSON.parse(readFileSync(join(process.cwd(), '.cursor', 'cli.json'), 'utf8'))
} catch {
  process.stderr.write('no .cursor/cli.json in workspace\n')
  process.exit(9)
}
const deny = config.permissions?.deny ?? []
if (!['Shell(*)', 'Read(**)', 'Write(**)'].every((d) => deny.includes(d))) {
  process.stderr.write('workspace does not deny all tools\n')
  process.exit(9)
}

const inputsOf = (text) =>
  (/<items>\n([\s\S]*?)\n<\/items>/.exec(text)?.[1] ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

// X posts whose text says NONTECH are judged not technical; every other X post is kept.
const answerFor = (inputs) => ({
  classifications: inputs.map((input) =>
    input.source === 'x' && input.text.includes('NONTECH')
      ? { id: input.id, keep: false }
      : {
          id: input.id,
          ...(input.source === 'x' ? { keep: true } : {}),
          category: 'CLI 与开发工具',
          tags: ['cli', 'typescript'],
          summary: `${input.id} 的摘要`,
          visibility: 'public',
          needsReview: false,
        },
  ),
})
const answer = answerFor(inputsOf(prompt))

switch (mode) {
  case 'ok':
    process.stdout.write(`${JSON.stringify(answer)}\n`)
    break
  case 'fenced':
    process.stdout.write(`Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n`)
    break
  case 'garbage':
    process.stdout.write('I could not classify these, sorry.\n')
    break
  case 'no-array':
    process.stdout.write('{"result":"done"}\n')
    break
  case 'fail':
    process.stdout.write(`${JSON.stringify(answer)}\n`)
    process.stderr.write('model quota exceeded\n')
    process.exit(3)
    break
  case 'sleep':
    setTimeout(() => process.stdout.write(`${JSON.stringify(answer)}\n`), 60_000)
    break
  case 'stdin': {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (input += d))
    process.stdin.on('end', () => {
      process.stdout.write(`${JSON.stringify(answerFor(inputsOf(input)))}\n`)
    })
    break
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`)
    process.exit(2)
}
