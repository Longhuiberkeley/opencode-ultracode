/**
 * storage.revokeTrust: delete the KV trust key; unknown name lists trusted names.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { StorageImpl } from "../src/storage.ts"
import { FakeFs, FakeKv } from "./fakes.ts"

const PROJECT = "/project"
const PERSONAL = "/home/u/.config/opencode/workflows"

function seedAnchors(fs: FakeFs): void {
  fs.files.set(`${PROJECT}/.anchor`, "")
  fs.files.set("/home/u/.config/opencode/.anchor", "")
}

test("revokeTrust deletes the trust record; load then requires re-trust", async () => {
  const kv = new FakeKv()
  const fs = new FakeFs()
  seedAnchors(fs)
  const storage = new StorageImpl({
    kv,
    fs,
    projectRoot: PROJECT,
    personalWorkflowDir: PERSONAL,
    projectID: "proj-1",
  })
  await storage.saveWorkflow("alpha", "return 1", { name: "alpha", source: "project" })
  await storage.trustWorkflow("alpha")
  assert.equal(storage.loadWorkflow("alpha")?.script, "return 1")
  await storage.revokeTrust("alpha")
  assert.throws(() => storage.loadWorkflow("alpha"), /is not trusted/)
  assert.equal(storage.workflowTrustState("alpha"), "untrusted")
})

test("revokeTrust unknown name lists currently trusted workflows", async () => {
  const kv = new FakeKv()
  const fs = new FakeFs()
  seedAnchors(fs)
  const storage = new StorageImpl({
    kv,
    fs,
    projectRoot: PROJECT,
    personalWorkflowDir: PERSONAL,
    projectID: "proj-1",
  })
  await storage.saveWorkflow("alpha", "return 1", { name: "alpha", source: "project" })
  await storage.saveWorkflow("beta", "return 2", { name: "beta", source: "project" })
  await storage.trustWorkflow("alpha")
  await assert.rejects(() => storage.revokeTrust("beta"), /Trusted workflows: alpha/)
  await assert.rejects(() => storage.revokeTrust("nope"), /Trusted workflows: alpha/)
})
