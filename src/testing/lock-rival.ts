// A separate process competing for a lock (lock.test.ts): waits until the given start time, tries once, prints
// "won" or the error's class name, and holds a won lock until its stdin closes, so every rival has tried by then.
import { acquireLock } from '../run/lock.ts'

const [path, start] = process.argv.slice(2)
while (Date.now() < Number(start)) {
  // spin until the shared start time, so the rivals arrive together
}
const closed = new Promise<void>((done) => process.stdin.on('end', done).resume())
try {
  const release = await acquireLock(path!)
  process.stdout.write('won\n')
  await closed
  await release()
} catch (e) {
  process.stdout.write(`${(e as Error).constructor.name}\n`)
}
