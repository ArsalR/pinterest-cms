// Lighthouse CI against a REPRESENTATIVE page set (Performance Covenant P2),
// not every page — so a 500-page site still deploys in minutes. Picks:
//   homepage · first post · first product (stores) · heaviest template (/about/).
// Budgets + server command come from lighthouserc.json; this only chooses URLs.
import { readdirSync, existsSync, statSync } from "node:fs"
import { execSync } from "node:child_process"

const dist = new URL("../dist", import.meta.url).pathname
const base = "http://localhost:4321"

function firstSubdir(sub) {
  const p = `${dist}/${sub}`
  if (!existsSync(p)) return null
  const dirs = readdirSync(p).filter((n) => {
    try { return statSync(`${p}/${n}`).isDirectory() } catch { return false }
  })
  return dirs.length ? dirs.sort()[0] : null
}

const urls = [`${base}/`]
const post = firstSubdir("posts")
if (post) urls.push(`${base}/posts/${post}/`)
const product = firstSubdir("products")
if (product) urls.push(`${base}/products/${product}/`)
// Heaviest text template = the About trust page.
if (existsSync(`${dist}/about`)) urls.push(`${base}/about/`)

console.log("Lighthouse representative page set:\n  " + urls.join("\n  "))
const args = urls.map((u) => `--collect.url=${u}`).join(" ")
execSync(`npx lhci autorun ${args}`, { stdio: "inherit" })
