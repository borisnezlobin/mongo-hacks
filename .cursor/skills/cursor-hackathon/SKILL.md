---
name: cursor-hackathon
description: Orientates teammates to Cursor IDE resources for the MongoDB Persistent Context Sprint hackathon. Use when setting up Cursor credits, project skills discovery, or MongoDB plugin alternatives.
---

# Cursor — hackathon setup

## Credits

MongoDB hackathon Cursor credits were emailed to registered participants. Redeem via the link in your Cursor email. Issues: hackathon Discord #cursor channel.

## Skills (this repo)

Cursor auto-discovers `.cursor/skills/*/SKILL.md` when the repo is open. **No install step** — clone and open.

See `SKILLS.txt` for the full list.

## MongoDB plugin (alternative to vendored skills)

If skills feel stale, install the official plugin:

```
/add-plugin mongodb-atlas
```

Or: Cursor Marketplace → search MongoDB. Bundles MCP + same skills as https://github.com/mongodb/agent-skills

This repo **vendors** those skills so all four laptops match without marketplace access.

## MCP

Copy `.cursor/mcp.json.example` → `.cursor/mcp.json`, paste Atlas sandbox URI, restart Cursor. Follow `mongodb-mcp-setup` skill.

## Team workflow

- One branch per lane; merge at gates only
- Commit every ~15 min on your lane branch
- Cross-lane API changes only via `shared/contracts.ts` + verbal announcement
