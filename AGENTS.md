# Youtarr fork agent instructions

## Project and scope

- This project is the fork https://github.com/kalleruud/Youtarr. Roadmap: https://github.com/kalleruud/Youtarr/issues/1.
- Development repository: `/mnt/user/appdata/t3-code/.t3/projects/youtarr` (persistent alias `/home/agent/.t3/projects/youtarr`). The Svetflix thread may coordinate work, but application implementation belongs in this project and its worktrees.
- Read this file, the shared `/home/agent/.agents/AGENTS.md`, `CLAUDE.md`, roadmap issue #1, the assigned issue, and relevant dependency issues before changing code.
- Follow the implementation, security, testing, and documentation standards in `CLAUDE.md`. The fork-specific workflow below takes precedence over its upstream branch/release instructions.
- Work only on the assigned issue. Preserve upstream notices and existing unrelated changes. Do not upgrade dependencies, refactor adjacent code, or redesign stack scripts without a requirement.

## Authorization and production boundaries

- For the product-owner-authorized issue delivery workflow, developers may create focused feature commits, push branches to `kalleruud/Youtarr`, and open/update PRs. The review manager may merge qualifying PRs under the gates below. Outside that scoped workflow, never commit unless explicitly instructed.
- Review the diff before every commit. Never commit credentials, cookies, tokens, private environment files, runtime configuration, downloaded media, or database contents.
- Development authorization does not authorize production deployment, container restarts, live data repair/migration, or production Compose changes. Ask only when an action actually needs separate authorization.
- Production uses the existing Svetflix stack and Jellyfin. Keep `youtarr-db`, its MariaDB image, and its named volume unchanged. Application migrations must be reviewed, additive where possible, and tested using disposable data.
- Never start a development application or upstream dev Compose against the production database. Use fixtures, mocks, temporary directories, and disposable test services.
- Prefer service-specific `env_file` for runtime environment settings, including non-secret settings. Youtarr and its database share private `.env.youtarr`; shared paths, ports, UID/GID, and Compose interpolation inputs belong in private stack `.env`. Do not create example environment files for this fork workflow.

## Team and isolation

- Team lead: this coordinating thread; the user is the product owner.
- Developers: Codex `gpt-6.1-terra`, `reasoningEffort: medium`.
- Review manager: Codex `gpt-6.1-sol`, `reasoningEffort: high`.
- Independent reviewers: Codex `gpt-6.1-sol`, `reasoningEffort: medium`.
- Start with at most two active implementation assignments, leaving capacity for review. Sequence dependency-bound features and avoid simultaneous edits to the same core modules where practical.
- Local T3 delegates inherit the calling thread's project. A different `target.projectId` is rejected and cannot rebind them. Execute developer/review delegation from a thread in the Youtarr project, with `isolation: "worktree"` for developers. Youtarr project ID: `a874b48d-d6b2-4067-b210-7bbc253cce7a`. Coordination may remain in Svetflix, but it needs a user-authorized Youtarr execution thread. Do not create shell worktrees or accidentally branch from the Svetflix repository.
- Each developer owns one issue, one branch, and one PR at a time. Branch from current fork `origin/main`; target `kalleruud/Youtarr:main`. Upstream's `dev` PR convention does not apply to this fork.
- T3 prepared worktrees omit uncommitted edits. Before the initial #2 PR lands, read this canonical project-root AGENTS.md explicitly. Preserve the existing uncommitted Dockerfile and .dockerignore changes; the #2 developer must inspect and include those intended changes and this file in the foundation PR. Do not assume a new worktree already contains them.
- Dependencies must be merged before dependent work is considered complete. Prefer independent ready issues over stacked PRs. If a dependency is deferred, record and defer blocked descendants without claiming completion.
- Use issue #2 for foundation closeout and fork-safe CI/release behavior, then progress through captions, TV identity/publication/artwork/migration, policies, streaming, and live recording. Apply #18/#19 reliability requirements as each feature is built.

## Developer delivery

1. Read the roadmap and assigned issue directly from GitHub, including comments and dependencies. Summarize intended behavior and identify the existing modules to extend.
2. Implement the acceptance criteria with the smallest coherent change. Follow the proposed architecture unless evidence supports a simpler design; explain material deviations in the PR.
3. Add meaningful regression tests for behavior and failure paths. Iterate until relevant tests pass. Run backend/frontend tests, lint, TypeScript checks, and frontend build as applicable; record exact commands and results.
4. Do not skip tests, lower checks, or hide failures to obtain green CI. Report unavailable host checks accurately. A missing mandatory check blocks readiness; explicitly documented manual release validation can remain a deployment gate.
5. Review your diff and open a non-draft PR only when ready. Use `Closes #N`, describe behavior, architectural changes, test evidence, and remaining release limitations. Drafts are appropriate while implementation is incomplete.
6. Link every created or pushed PR through T3 immediately, including every layer of any approved stack.
7. Address CI failures and actionable review feedback on the same branch; retest and push focused fixes. Developers never approve or merge their own PRs.
8. Delegated children do not start persistent PR watches or polling loops. Report the PR URL, head SHA, checks/reviews, and blockers to the lead; the lead owns persistent watches and dispatches follow-up developer tasks until merge or deferral.

## Review and merge

- The review manager may delegate independent reviews; developer and reviewer children do their own work without further delegation.
- Request a fresh reviewer task for each non-draft PR head update or substantive new concern. Review the exact head SHA against the assigned issue, roadmap constraints, code standards, tests, and relevant existing comments. Do not reuse stale approval after code changes.
- Keep one active review per PR head; supersede obsolete reviews. Ignore ordinary drafts until marked ready. After three-cycle deferral, ignore that PR until the owner explicitly returns it to scope.
- Reviewers post necessary actionable GitHub feedback, following the available leaving-pr-comments skill. Separate blocking defects from optional suggestions. Include file/line evidence and a concrete failure scenario.
- Reviewers report findings, checked head SHA, validation, and a confidence score from 0 to 1 with a short explanation. Confidence is supporting evidence, not a substitute for acceptance criteria or CI.
- Good enough to merge means acceptance criteria met, applicable required CI green on the current revision, confidence at least 0.8 supported by evidence, and no unresolved material correctness, security, compatibility, or data-loss concerns. Cosmetic preferences are not blockers. Do not bypass protections or dismiss material concerns to meet a quota.
- Use squash merge, serialize merges, and recheck affected PRs after base changes. Record the exact reviewed revision and merge result.
- Limit each PR to three substantive review cycles total. Each cycle reviews an initial implementation or revised implementation and yields a verdict; metadata edits and duplicate checks do not add cycles. A passing third cycle may merge. If the third cycle still fails, mark the PR draft, record unresolved blockers and the cycle count, and exclude it from the current delivery goal. Do not reset the count by replacing the PR.
- After a merge, verify whether the linked issue is actually complete, then update roadmap #1's corresponding checkbox and record the merged PR link. Partial work stays unchecked.
- The lead owns persistent T3 PR watches and follow-up dispatch. Managers and delegated children return actionable state instead of attempting unsupported background loops. Follow T3 tool lifecycle instructions.

## Build and release facts

- The owner confirmed the fork builds and runs in Svetflix. Production Compose currently has a build-only `youtarr` service whose context defaults to the canonical project-root checkout. It has no explicit app image tag or pull policy; the database service remains separate.
- The Dockerfile builds the React frontend inside Docker. Do not add unnecessary host npm requirements or build helper scripts.
- The current build source checkout is used by production's manual rebuild operation. Never switch its branch, reset it, clean it, or pull feature code into it as part of routine worktree development.
- This T3 environment currently has no Docker CLI/socket. Run available source checks here; host builds, container smoke tests, and Jellyfin/JellySee validation require CI or separately authorized Unraid operations. Do not expose Docker access incidentally.
- Upstream release workflows trigger on pushes to main/dev and include upstream publishing/notification behavior. Before routine fork merges, issue #2 must make that behavior fork-safe while preserving useful PR CI. Do not manually trigger releases, publish upstream images, or configure production credentials.
- Keep a recoverable prior app image and matching database/config backup before any future deployment involving schema changes. Image rollback alone does not reverse a database migration.
