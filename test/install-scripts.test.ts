/**
 * scripts/install.sh + uninstall.sh: self-contained copy install (v2).
 *
 * Run: node --experimental-strip-types --test test/install-scripts.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."))
const INSTALL = join(REPO, "scripts/install.sh")
const UNINSTALL = join(REPO, "scripts/uninstall.sh")

function bashPath(): string | undefined {
  const candidates = ["bash", "/bin/bash", "/usr/bin/bash"]
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-c", "echo ok"], { encoding: "utf8" })
    if (r.status === 0 && (r.stdout ?? "").includes("ok")) return bin
  }
  return undefined
}

const BASH = bashPath()
const skip = BASH ? false : "bash missing"

type Snap = { dirs: string[]; files: Record<string, string> }

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function snapshot(root: string): Snap {
  const dirs: string[] = []
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const rel = relative(root, abs)
      const st = statSync(abs)
      if (st.isDirectory()) {
        dirs.push(rel)
        walk(abs)
      } else if (st.isFile()) {
        files[rel] = hashFile(abs)
      }
    }
  }
  walk(root)
  dirs.sort()
  return { dirs, files }
}

/** Every authored file under the plugin dir (node_modules excluded). */
function authoredFiles(pluginDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(abs)
    }
  }
  walk(pluginDir)
  return out
}

function run(
  script: string,
  args: string[],
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BASH!, [script, ...args], {
    encoding: "utf8",
    cwd: cwd ?? REPO,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

function pluginDir(project: string): string {
  return join(project, ".opencode/plugins/ultracode")
}

test("install writes a self-contained relocatable tree; idempotent; uninstall restores", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-install-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const before = snapshot(project)
    const first = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.equal(first.status, 0, first.stderr || first.stdout)

    const dir = pluginDir(project)
    // Core layout: relative entry, copied sources, skill, manifest, marker.
    const index = readFileSync(join(dir, "index.ts"), "utf8")
    assert.match(index, /export \{ default \} from "\.\/src\/index\.ts"/)
    assert.equal(existsSync(join(dir, "src/index.ts")), true)
    assert.equal(existsSync(join(dir, "src/supervisor.ts")), true)
    assert.equal(existsSync(join(dir, "skills/ultracode.md")), true)
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string
      version?: string
      dependencies?: Record<string, string>
    }
    assert.equal(pkg.name, "opencode-ultracode")
    assert.ok(typeof pkg.version === "string" && pkg.version !== "")
    assert.ok(pkg.dependencies && "@opencode/plugin" in pkg.dependencies)
    assert.match(readFileSync(join(dir, ".ultracode-install"), "utf8"), /"v":2/)
    // TUI is opt-in.
    assert.equal(existsSync(join(dir, "tui.tsx")), false)
    // No absolute path into the source repo anywhere we authored.
    for (const file of authoredFiles(dir)) {
      const content = readFileSync(file, "utf8")
      assert.ok(!content.includes(REPO), `absolute repo path leaked into ${file}`)
    }

    // Idempotent: rerun rebuilds the same tree.
    const afterFirst = snapshot(project)
    const second = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.deepEqual(snapshot(project), afterFirst)

    // --tui writes a relative sibling entry.
    const withTui = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps", "--tui"])
    assert.equal(withTui.status, 0, withTui.stderr || withTui.stdout)
    const tui = readFileSync(join(dir, "tui.tsx"), "utf8")
    assert.match(tui, /@jsxImportSource solid-js/)
    assert.match(tui, /export \{ default \} from "\.\/src\/tui\.tsx"/)
    assert.ok(!tui.includes(REPO), tui)

    const un = run(UNINSTALL, ["--project", project, "--repo", REPO])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.match(un.stdout, /saved workflows left untouched/)
    assert.match(un.stdout, /removed ultracode install entries/)
    const after = snapshot(project)
    assert.deepEqual(after.files, before.files)
    assert.deepEqual(after.dirs, before.dirs)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("full install (without --no-deps) ships the runtime dependency tree", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-deps-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const inst = run(INSTALL, ["--project", project, "--repo", REPO])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const dir = pluginDir(project)
    assert.equal(existsSync(join(dir, "node_modules/@opencode/plugin/package.json")), true)
    // typescript is a devDependency — never shipped.
    assert.equal(existsSync(join(dir, "node_modules/typescript")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("v1 absolute-path shim install is migrated to the self-contained layout", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-migrate-"))
  const project = join(root, "proj")
  const dir = pluginDir(project)
  mkdirSync(dir, { recursive: true })
  try {
    // Recreate a v1 install: absolute-path re-export shims.
    writeFileSync(join(dir, "index.ts"), `export { default } from "${join(REPO, "src/index.ts")}"\n`)
    writeFileSync(
      join(dir, "tui.tsx"),
      `/** @jsxImportSource solid-js */\nexport { default } from "${join(REPO, "src/tui.tsx")}"\n`,
    )
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps", "--tui"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const index = readFileSync(join(dir, "index.ts"), "utf8")
    assert.match(index, /"\.\/src\/index\.ts"/)
    assert.ok(!index.includes(REPO), index)
    const tui = readFileSync(join(dir, "tui.tsx"), "utf8")
    assert.ok(!tui.includes(REPO), tui)
    assert.equal(existsSync(join(dir, ".ultracode-install")), true)
    for (const file of authoredFiles(dir)) {
      const content = readFileSync(file, "utf8")
      assert.ok(!content.includes(REPO), `absolute repo path leaked into ${file}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install refuses to clobber a foreign plugin dir", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-foreign-"))
  const project = join(root, "proj")
  const dir = pluginDir(project)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, "index.ts"), 'export default { id: "someone-elses" }\n')
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.notEqual(inst.status, 0)
    assert.match(inst.stderr, /refusing to overwrite/)
    assert.equal(readFileSync(join(dir, "index.ts"), "utf8"), 'export default { id: "someone-elses" }\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uninstall removes only our entries, keeps foreign files, works after the repo moves away", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-un-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const dir = pluginDir(project)
    writeFileSync(join(dir, "foreign-notes.txt"), "keep me\n")
    mkdirSync(join(project, ".opencode/plugins/other"), { recursive: true })
    writeFileSync(join(project, ".opencode/plugins/other/index.ts"), "export {}\n")

    const un = run(UNINSTALL, ["--project", project])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.equal(existsSync(join(dir, "src")), false)
    assert.equal(existsSync(join(dir, "index.ts")), false)
    assert.equal(existsSync(join(dir, "package.json")), false)
    assert.equal(existsSync(join(dir, "foreign-notes.txt")), true)
    assert.equal(existsSync(join(project, ".opencode/plugins/other/index.ts")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install --write-config twice yields a single plugins entry", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-config-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const args = ["--project", project, "--repo", REPO, "--write-config", "--no-deps"]
    const first = run(INSTALL, args)
    assert.equal(first.status, 0, first.stderr || first.stdout)
    const second = run(INSTALL, args)
    assert.equal(second.status, 0, second.stderr || second.stdout)
    const configPath = join(project, ".opencode/opencode.json")
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins?: unknown[]
    }
    assert.ok(Array.isArray(doc.plugins))
    const matches = (doc.plugins ?? []).filter((entry) => {
      if (typeof entry === "string") return entry.replace(/\/+$/, "") === "./plugins/ultracode"
      if (entry && typeof entry === "object" && "package" in entry) {
        return String((entry as { package: string }).package).replace(/\/+$/, "") === "./plugins/ultracode"
      }
      return false
    })
    assert.equal(matches.length, 1, JSON.stringify(doc, null, 2))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install/uninstall quote a project dir that contains spaces", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-space-"))
  const project = join(root, "my project")
  mkdirSync(project)
  try {
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--tui", "--no-deps"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    assert.equal(existsSync(join(pluginDir(project), "index.ts")), true)
    assert.equal(existsSync(join(pluginDir(project), "tui.tsx")), true)
    const un = run(UNINSTALL, ["--project", project, "--repo", REPO])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.equal(existsSync(pluginDir(project)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install --write-config then uninstall removes the plugins entry and keeps unrelated keys", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-roundtrip-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    mkdirSync(join(project, ".opencode"), { recursive: true })
    const configPath = join(project, ".opencode/opencode.json")
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          model: "keep-me",
          plugins: [{ package: "other-plugin" }],
          theme: "dark",
        },
        null,
        2,
      ) + "\n",
    )
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--write-config", "--no-deps"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const afterInstall = JSON.parse(readFileSync(configPath, "utf8")) as {
      model?: string
      theme?: string
      plugins?: unknown[]
    }
    assert.equal(afterInstall.model, "keep-me")
    assert.equal(afterInstall.theme, "dark")
    assert.ok(Array.isArray(afterInstall.plugins))
    assert.equal(afterInstall.plugins!.length, 2)

    const un = run(UNINSTALL, ["--project", project, "--repo", REPO])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    const after = JSON.parse(readFileSync(configPath, "utf8")) as {
      model?: string
      theme?: string
      plugins?: unknown[]
    }
    assert.equal(after.model, "keep-me")
    assert.equal(after.theme, "dark")
    assert.deepEqual(after.plugins, [{ package: "other-plugin" }])
    const keys = Object.keys(after)
    assert.deepEqual(keys, ["model", "plugins", "theme"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uninstall --purge-workflows deletes only recognized pairs and leaves stray files", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-purge-wf-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const wf = join(project, ".opencode/workflows")
    mkdirSync(wf, { recursive: true })
    writeFileSync(join(wf, "demo.js"), "return 1\n")
    writeFileSync(join(wf, "demo.json"), JSON.stringify({ name: "demo", version: 1 }, null, 2) + "\n")
    writeFileSync(join(wf, "stray.js"), "return 99\n")
    writeFileSync(join(wf, "notes.json"), "{}\n")
    writeFileSync(join(wf, "mismatch.js"), "return 0\n")
    writeFileSync(join(wf, "mismatch.json"), JSON.stringify({ name: "other" }, null, 2) + "\n")

    const un = run(UNINSTALL, ["--project", project, "--repo", REPO, "--purge-workflows", "--yes"])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.match(un.stdout, /recognized saved-workflow pairs to delete:/)
    assert.match(un.stdout, /demo\.js/)
    assert.match(un.stdout, /demo\.json/)
    assert.equal(existsSync(join(wf, "demo.js")), false)
    assert.equal(existsSync(join(wf, "demo.json")), false)
    assert.equal(existsSync(join(wf, "stray.js")), true)
    assert.equal(existsSync(join(wf, "notes.json")), true)
    assert.equal(existsSync(join(wf, "mismatch.js")), true)
    assert.equal(existsSync(join(wf, "mismatch.json")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uninstall --purge removes matching skill mirror and runs/, leaves foreign files", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-purge-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--no-deps"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    const wf = join(project, ".opencode/workflows")
    mkdirSync(join(wf, "runs"), { recursive: true })
    writeFileSync(join(wf, "runs", "script.js"), "return 1\n")
    writeFileSync(join(wf, "demo.js"), "return 1\n")
    writeFileSync(join(wf, "demo.json"), "{}\n")
    const skillSrc = join(REPO, "skills/ultracode.md")
    writeFileSync(join(wf, "ultracode-skill.md"), readFileSync(skillSrc))
    mkdirSync(join(project, ".opencode/plugins/other"), { recursive: true })
    writeFileSync(join(project, ".opencode/plugins/other/index.ts"), "export {}\n")

    const un = run(UNINSTALL, ["--project", project, "--repo", REPO, "--purge"])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.match(un.stdout, /KV residue/)
    assert.equal(existsSync(join(wf, "runs")), false)
    assert.equal(existsSync(join(wf, "ultracode-skill.md")), false)
    assert.equal(existsSync(join(wf, "demo.js")), true)
    assert.equal(existsSync(join(wf, "demo.json")), true)
    assert.equal(existsSync(join(project, ".opencode/plugins/other/index.ts")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
