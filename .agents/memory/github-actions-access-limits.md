---
name: GitHub Actions access limits
description: Constraints affecting GitHub workflow edits and Actions log diagnosis from this Replit environment.
---

GitHub connector requests targeting `.github/workflows` and protected GitHub Actions job-log downloads can be blocked by the environment’s proxy, even when ordinary repository content requests succeed.

**Why:** The workflow must sometimes be created or edited through GitHub’s signed-in web interface, and the repository owner may need to copy the relevant `FAILURE:` / `Caused by:` Gradle output for diagnosis.

**How to apply:** Use the GitHub API for normal source files and run status checks. When workflow-file changes or detailed Actions logs are blocked, avoid speculative native build edits; ask for the signed-in workflow edit or concise failure section instead.