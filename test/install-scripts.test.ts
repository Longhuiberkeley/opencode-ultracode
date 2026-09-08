/**
 * Phase 4: scripts/install.sh + uninstall.sh idempotency and safety.
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

function pluginIndex(project: string): string {
  return join(project, ".opencode/plugins/ultracode/index.ts")
}

function pluginTui(project: string): string {
  return join(project, ".opencode/plugins/ultracode/tui.tsx")
}

test("install.sh is idempotent; --tui writes sibling; uninstall restores files", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-install-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const before = snapshot(project)
    const first = run(INSTALL, ["--project", project, "--repo", REPO])
    assert.equal(first.status, 0, first.stderr || first.stdout)
    const indexPath = pluginIndex(project)
    assert.equal(existsSync(indexPath), true)
    const index = readFileSync(indexPath, "utf8")
    assert.match(index, /export \{ default \} from /)
    assert.ok(index.includes(join(REPO, "src/index.ts")), index)
    assert.equal(existsSync(pluginTui(project)), false)

    const afterFirst = snapshot(project)
    const second = run(INSTALL, ["--project", project, "--repo", REPO])
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.deepEqual(snapshot(project), afterFirst)

    const withTui = run(INSTALL, ["--project", project, "--repo", REPO, "--tui"])
    assert.equal(withTui.status, 0, withTui.stderr || withTui.stdout)
    const tuiPath = pluginTui(project)
    assert.equal(existsSync(tuiPath), true)
    const tui = readFileSync(tuiPath, "utf8")
    assert.ok(tui.includes(join(REPO, "src/tui.tsx")), tui)
    assert.match(tui, /export \{ default \} from /)

    const un = run(UNINSTALL, ["--project", project, "--repo", REPO])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.match(un.stdout, /saved workflows left untouched/)
    const after = snapshot(project)
    assert.deepEqual(after.files, before.files)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install --write-config twice yields a single plugins entry", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "uc-config-"))
  const project = join(root, "proj")
  mkdirSync(project)
  try {
    const args = ["--project", project, "--repo", REPO, "--write-config"]
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
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--tui"])
    assert.equal(inst.status, 0, inst.stderr || inst.stdout)
    assert.equal(existsSync(pluginIndex(project)), true)
    assert.equal(existsSync(pluginTui(project)), true)
    const un = run(UNINSTALL, ["--project", project, "--repo", REPO])
    assert.equal(un.status, 0, un.stderr || un.stdout)
    assert.equal(existsSync(pluginIndex(project)), false)
    assert.equal(existsSync(pluginTui(project)), false)
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
    const inst = run(INSTALL, ["--project", project, "--repo", REPO, "--write-config"])
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
    const inst = run(INSTALL, ["--project", project, "--repo", REPO])
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
    const inst = run(INSTALL, ["--project", project, "--repo", REPO])
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
