// Verifies worker termination interrupts an infinite loop that starts AFTER an await.
// This is the availability guarantee the workflow runtime depends on.
import { Worker } from "node:worker_threads"

const code = `
  (async () => {
    await Promise.resolve()
    while (true) {}
  })()
`

const w = new Worker(code, { eval: true })

const killTimer = setTimeout(() => {
  const t0 = Date.now()
  w.terminate()
    .then(() => {
      console.log(`TERMINATED in ${Date.now() - t0}ms; main thread alive — PASS`)
      process.exit(0)
    })
    .catch((e) => {
      console.log("terminate failed:", e)
      process.exit(1)
    })
}, 300)

setTimeout(() => {
  console.log("FAIL: main thread still alive after 5s — worker not terminated")
  process.exit(1)
}, 5000)

w.on("exit", () => clearTimeout(killTimer))
