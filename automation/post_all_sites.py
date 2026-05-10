#!/usr/bin/env python3
"""
post_all_sites.py — content generation + multi-site posting.

For each site listed in sites.json, generate one Pinterest-style post:
  1. Pick a topic (rotates through CATEGORIES per site)
  2. Generate title + content via OpenAI
  3. Search Pexels for 6–10 relevant images, download them
  4. Upload images to the site's CMS via /v1/upload
  5. Create the post via /v1/posts with cover + gallery

Designed to run from a GitHub Actions cron — uses asyncio + aiohttp
to handle ~10 concurrent sites without exhausting rate limits.

Required env vars:
  OPENAI_API_KEY       — OpenAI key
  PEXELS_API_KEY       — Pexels API key (free)
  SITES_JSON           — path to sites.json (default: ./sites.json)

sites.json format:
  [
    {
      "hostname": "example.com",
      "api_key":  "cms_live_…",
      "categories": ["interior-design", "decor", "home"],
      "tone":      "warm and inspiring"
    },
    …
  ]
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp


# ──────────────────────────── Config ────────────────────────────

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY", "").strip()
SITES_JSON = os.environ.get("SITES_JSON", "sites.json")

CONCURRENCY = 10                # max sites in flight at once
IMAGES_PER_POST = 8             # gallery size per post
OPENAI_MODEL = "gpt-4o-mini"    # cheap + fast; bump for quality
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=120)


# ──────────────────────────── Models ────────────────────────────


@dataclass
class Site:
    hostname: str
    api_key: str
    categories: list[str]
    tone: str = "engaging and informative"


@dataclass
class GeneratedPost:
    title: str
    slug: str
    excerpt: str
    content_md: str
    seo_title: str
    seo_description: str
    image_query: str


# ──────────────────────────── Helpers ───────────────────────────


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")[:80]


def md_to_html(md: str) -> str:
    """Tiny markdown-to-HTML for the subset we generate.

    The CMS stores posts as HTML, but the LLM produces markdown.
    This handles headers, paragraphs, lists, bold, italic, and links —
    enough for the LLM-generated content shape.
    """
    out: list[str] = []
    in_ul = False
    for raw in md.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            if in_ul:
                out.append("</ul>")
                in_ul = False
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            level = len(m.group(1))
            out.append(f"<h{level}>{m.group(2)}</h{level}>")
            continue

        if line.lstrip().startswith(("- ", "* ")):
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{line.lstrip()[2:]}</li>")
            continue

        if in_ul:
            out.append("</ul>")
            in_ul = False
        out.append(f"<p>{line}</p>")

    if in_ul:
        out.append("</ul>")

    html = "\n".join(out)
    # Inline formatting.
    html = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html)
    html = re.sub(r"\*(.+?)\*", r"<em>\1</em>", html)
    html = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', html)
    return html


# ──────────────────────────── OpenAI ────────────────────────────

OPENAI_URL = "https://api.openai.com/v1/chat/completions"

PROMPT_TEMPLATE = """You are writing a Pinterest-style blog post.

Topic category: {category}
Tone: {tone}
Date: {date}

Generate a fresh, specific, visually-evocative post. Output a SINGLE valid JSON
object with these exact keys (no preamble, no markdown fences):

{{
  "title": "An attention-grabbing 6-12 word headline",
  "slug": "url-safe-slug",
  "excerpt": "1-2 sentence hook (under 200 chars)",
  "content_md": "Full article in markdown. Use ## headings, paragraphs, and at least one bullet list. Aim for 400-700 words. NO image tags — images are added separately.",
  "seo_title": "SEO-optimized title (under 60 chars)",
  "seo_description": "Meta description (under 155 chars)",
  "image_query": "2-4 word search query for stock images relevant to this post"
}}
"""


async def generate_post(
    session: aiohttp.ClientSession, category: str, tone: str
) -> GeneratedPost:
    prompt = PROMPT_TEMPLATE.format(
        category=category, tone=tone, date=datetime.utcnow().date().isoformat()
    )
    body = {
        "model": OPENAI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.85,
        "response_format": {"type": "json_object"},
    }
    async with session.post(
        OPENAI_URL,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json=body,
    ) as r:
        r.raise_for_status()
        data = await r.json()
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)

    return GeneratedPost(
        title=parsed["title"],
        slug=parsed.get("slug") or slugify(parsed["title"]),
        excerpt=parsed.get("excerpt", "")[:200],
        content_md=parsed["content_md"],
        seo_title=parsed.get("seo_title", parsed["title"])[:60],
        seo_description=parsed.get("seo_description", "")[:155],
        image_query=parsed.get("image_query", category),
    )


# ──────────────────────────── Pexels ────────────────────────────


async def fetch_pexels_images(
    session: aiohttp.ClientSession, query: str, count: int
) -> list[dict[str, Any]]:
    """Return list of {url, alt} for top N images matching the query."""
    async with session.get(
        "https://api.pexels.com/v1/search",
        headers={"Authorization": PEXELS_API_KEY},
        params={"query": query, "per_page": count, "orientation": "portrait"},
    ) as r:
        r.raise_for_status()
        data = await r.json()
    return [
        {
            "url": p["src"]["large2x"],
            "alt": p.get("alt") or query,
        }
        for p in data.get("photos", [])
    ]


async def download(session: aiohttp.ClientSession, url: str) -> bytes:
    async with session.get(url) as r:
        r.raise_for_status()
        return await r.read()


# ──────────────────────────── CMS API ───────────────────────────


async def cms_upload_images(
    session: aiohttp.ClientSession,
    site: Site,
    images: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Download images from Pexels and upload to the site's /v1/upload."""
    blobs: list[tuple[bytes, str, str]] = []
    for i, img in enumerate(images):
        try:
            data = await download(session, img["url"])
        except Exception as e:
            print(f"  ⚠ download failed for {img['url']}: {e}", file=sys.stderr)
            continue
        ext = "jpg"
        if ".png" in img["url"].lower():
            ext = "png"
        blobs.append((data, f"img-{i}.{ext}", img["alt"]))

    if not blobs:
        return []

    form = aiohttp.FormData()
    for data, fname, _alt in blobs:
        form.add_field(
            "files[]", data, filename=fname, content_type="image/jpeg"
        )

    async with session.post(
        f"https://{site.hostname}/api/public/v1/upload",
        headers={"Authorization": f"Bearer {site.api_key}"},
        data=form,
    ) as r:
        if r.status != 200:
            text = await r.text()
            raise RuntimeError(f"upload failed ({r.status}): {text[:200]}")
        result = await r.json()

    uploaded = result.get("files", [])
    out: list[dict[str, str]] = []
    for i, f in enumerate(uploaded):
        alt = blobs[i][2] if i < len(blobs) else ""
        out.append({"url": f["url"], "alt": alt})
    return out


async def cms_create_post(
    session: aiohttp.ClientSession,
    site: Site,
    post: GeneratedPost,
    category: str,
    images: list[dict[str, str]],
) -> dict[str, Any]:
    body = {
        "title": post.title,
        "slug": post.slug,
        "content": md_to_html(post.content_md),
        "excerpt": post.excerpt,
        "category": category,
        "coverImage": images[0]["url"] if images else None,
        "images": images,
        "seoTitle": post.seo_title,
        "seoDescription": post.seo_description,
        "published": True,
    }
    async with session.post(
        f"https://{site.hostname}/api/public/v1/posts",
        headers={
            "Authorization": f"Bearer {site.api_key}",
            "Content-Type": "application/json",
        },
        json=body,
    ) as r:
        text = await r.text()
        if r.status not in (200, 201):
            raise RuntimeError(f"create_post failed ({r.status}): {text[:300]}")
        return json.loads(text)


# ──────────────────────────── Per-site task ────────────────────


async def post_to_site(site: Site, sem: asyncio.Semaphore) -> tuple[str, str]:
    async with sem:
        async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
            try:
                category = random.choice(site.categories)
                print(f"[{site.hostname}] generating ({category})…")
                post = await generate_post(session, category, site.tone)

                print(f"[{site.hostname}] fetching images for '{post.image_query}'…")
                pexels = await fetch_pexels_images(
                    session, post.image_query, IMAGES_PER_POST
                )
                if not pexels:
                    return site.hostname, f"⚠ no images for '{post.image_query}' — skipped"

                print(f"[{site.hostname}] uploading {len(pexels)} images…")
                uploaded = await cms_upload_images(session, site, pexels)
                if not uploaded:
                    return site.hostname, "⚠ all uploads failed — skipped"

                print(f"[{site.hostname}] creating post '{post.title}'…")
                result = await cms_create_post(session, site, post, category, uploaded)

                created = result.get("post", {})
                return site.hostname, f"✓ {created.get('slug', post.slug)}"
            except Exception as e:
                return site.hostname, f"✗ {type(e).__name__}: {e}"


# ──────────────────────────── Main ─────────────────────────────


async def main() -> int:
    if not OPENAI_API_KEY:
        print("FATAL: OPENAI_API_KEY not set", file=sys.stderr)
        return 1
    if not PEXELS_API_KEY:
        print("FATAL: PEXELS_API_KEY not set", file=sys.stderr)
        return 1

    sites_path = Path(SITES_JSON)
    if not sites_path.is_file():
        print(f"FATAL: sites.json not found at {sites_path}", file=sys.stderr)
        return 1

    raw = json.loads(sites_path.read_text())
    sites = [
        Site(
            hostname=s["hostname"],
            api_key=s["api_key"],
            categories=s.get("categories", ["lifestyle"]),
            tone=s.get("tone", "engaging and informative"),
        )
        for s in raw
    ]
    if not sites:
        print("No sites configured.")
        return 0

    print(f"▶ posting to {len(sites)} site(s) at {datetime.utcnow().isoformat()}Z")
    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(
        *[post_to_site(s, sem) for s in sites], return_exceptions=False
    )

    print()
    print("▶ summary:")
    ok = 0
    for hostname, msg in results:
        print(f"  {hostname:40s} {msg}")
        if msg.startswith("✓"):
            ok += 1
    print(f"\n{ok}/{len(sites)} succeeded.")
    return 0 if ok == len(sites) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
