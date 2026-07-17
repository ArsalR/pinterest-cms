// scripts/ci-stub-cms.mjs — a throwaway CMS stub for CI builds (the preset
// matrix). Returns an empty-but-valid site so `npm run build` succeeds without a
// real CMS; the point of the matrix is that every preset passes the covenant
// gates, not that content renders. Listens on :8799.
import { createServer } from "node:http"

createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if ((req.url ?? "").includes("/products")) return res.end(JSON.stringify({ products: [], total: 0 }))
  res.end(JSON.stringify({ posts: [], total: 0 }))
}).listen(8799, () => console.log("ci-stub-cms on :8799"))
