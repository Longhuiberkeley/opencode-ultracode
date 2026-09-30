import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"

const cli = path.resolve("src/subagent-config.py")

/** A fake HOME plus a fake opencode2 that serves `api get /api/agent|model` from fixtures. */
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "subagent-config-"))
  const home = path.join(dir, "home")
  const config = path.join(home, ".config/opencode")
  const project = path.join(dir, "project")
  await mkdir(path.join(config, "agents"), { recursive: true })
  await mkdir(path.join(project, ".opencode/agents"), { recursive: true })
  const bin = path.join(dir, "fake-opencode2")
  await writeFile(bin, `#!/bin/sh
case "$3" in
  /api/agent) echo '{"data":[{"id":"general","mode":"subagent"},{"id":"explore","mode":"subagent"}]}' ;;
  /api/model) echo '{"data":[{"providerID":"p","id":"a","variants":[{"id":"high"}]},{"providerID":"q","id":"b"}]}' ;;
esac
`, { mode: 0o755 })
  const run = (...args: string[]) => spawnSync("python3", [cli, ...args],
    { encoding: "utf8", cwd: project, env: { ...process.env, HOME: home, SC_BIN: bin } })
  return { dir, config, project, run }
}

test("subagent-config: set and unset write the global agent file without leaving temp files", async () => {
  const box = await sandbox()
  try {
    const file = path.join(box.config, "agents/general.md")
    await writeFile(file, "---\ndescription: \"General\"\nmode: subagent\n---\nYou are general.\n")
    const set = box.run("set", "general", "p/a#high")
    assert.equal(set.status, 0, set.stderr)
    assert.equal(await readFile(file, "utf8"), "---\ndescription: \"General\"\nmode: subagent\nmodel: p/a#high\n---\nYou are general.\n")
    assert.notEqual(box.run("set", "general", "p/a#ultra").status, 0, "an unknown variant is refused")
    assert.equal(box.run("unset", "general").status, 0)
    assert.doesNotMatch(await readFile(file, "utf8"), /model:/)
    assert.deepEqual(await readdir(path.join(box.config, "agents")), ["general.md"])
  } finally { await rm(box.dir, { recursive: true, force: true }) }
})

test("subagent-config: provider off/on keeps unrelated config, backs up, and writes atomically", async () => {
  const box = await sandbox()
  try {
    const file = path.join(box.config, "opencode.json")
    const original = JSON.stringify({ theme: "custom", plugins: ["x"] }, null, 2) + "\n"
    await writeFile(file, original)
    const off = box.run("provider", "off", "q")
    assert.equal(off.status, 0, off.stderr)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "custom", plugins: ["x"], disabled_providers: ["q"] })
    assert.equal(await readFile(file + ".subagent-config.bak", "utf8"), original)
    assert.equal(box.run("provider", "on", "q").status, 0)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).disabled_providers, [])
    assert.deepEqual((await readdir(box.config)).sort(), ["agents", "opencode.json", "opencode.json.subagent-config.bak"])
  } finally { await rm(box.dir, { recursive: true, force: true }) }
})

test("subagent-config: a config that changed since it was read is not overwritten", async () => {
  const box = await sandbox()
  try {
    const file = path.join(box.config, "opencode.json")
    await writeFile(file, "{}\n")
    const guard = spawnSync("python3", ["-B", "-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("sc", ${JSON.stringify(cli)})
sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
path = pathlib.Path(${JSON.stringify(file)})
cfg, before = sc.read_config(path)
path.write_text('{"theme": "edited elsewhere"}\\n')
sc.save_config(path, {"disabled_providers": ["q"]}, before)
`], { encoding: "utf8" })
    assert.notEqual(guard.status, 0)
    assert.match(guard.stderr, /changed while editing; retry/)
    assert.equal(await readFile(file, "utf8"), '{"theme": "edited elsewhere"}\n')
  } finally { await rm(box.dir, { recursive: true, force: true }) }
})

test("subagent-config: list flags a project agent file that overrides the global pin", async () => {
  const box = await sandbox()
  try {
    await writeFile(path.join(box.config, "agents/general.md"), "---\nmodel: p/a\n---\n")
    await writeFile(path.join(box.project, ".opencode/agents/general.md"), "---\nmodel: q/b\n---\n")
    const listed = box.run("list")
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /project file \.opencode\/agents\/general\.md wins here: q\/b/)
    assert.doesNotMatch(listed.stdout, /agents\/explore\.md wins/)
  } finally { await rm(box.dir, { recursive: true, force: true }) }
})

test("installer creates a shim when there is none and dispatches both config commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-newshim-"))
  try {
    const real = path.join(dir, "real")
    const shimDir = path.join(dir, "shim")
    const plugin = path.join(dir, "plugin")
    await mkdir(real); await mkdir(path.join(plugin, "src"), { recursive: true })
    await writeFile(path.join(real, "opencode2"), "#!/bin/sh\necho real \"$@\"\n", { mode: 0o755 })
    await writeFile(path.join(plugin, "src/ultracode-config-cli.mjs"), "// installed")
    await writeFile(path.join(plugin, "src/subagent-config.py"), "import sys\nprint('subagent', *sys.argv[1:])\n")
    const shim = path.join(shimDir, "opencode2")
    const env = { ...process.env, PATH: `${shimDir}:${real}:${process.env.PATH}` }
    const script = path.resolve("scripts/install-config-cli.sh")
    execFileSync("bash", [script, shim, plugin], { env })
    execFileSync("bash", [script, shim, plugin], { env })
    const text = await readFile(shim, "utf8")
    assert.equal(text.match(/# ultracode-config dispatch/g)?.length, 1)
    assert.equal(text.match(/# subagent-config dispatch/g)?.length, 1)
    assert.equal(execFileSync(shim, ["run", "x"], { env, encoding: "utf8" }), "real run x\n")
    assert.equal(execFileSync(shim, ["subagent-config", "list"], { env, encoding: "utf8" }), "subagent list\n")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
