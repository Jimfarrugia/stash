# Domain context

## Ubiquitous language

- **Factory**: the complete OpenCode and GitHub workflow installed in a product repository.
- **Coordinator**: the primary agent through which the human plans and dispatches work.
- **Worker**: one implementation subagent bound to one issue, branch, and worktree.
- **Reviewer**: a read-only subagent that checks a worker's diff against standards and spec.
- **Feature**: the parent GitHub issue containing an approved implementation spec.
- **Decision ticket**: a Wayfinder issue that resolves uncertainty; it is not build work.
- **Implementation ticket**: one independently verifiable tracer-bullet slice of a feature.
- **Frontier**: ready implementation tickets whose blockers are all closed.
- **Claim**: the coordinator's machine-readable issue comment linking a running session,
  branch, and worktree to a ticket.
- **Human queue**: issues that require a decision, access, approval, or other human action.

Avoid calling decision tickets "tasks" or treating pull requests as queue tickets.

## Stash language

**Bookmark**: A saved link with an editable title, optional plain-text notes,
tags, creation and update times, and archive status. It is not a stored copy of
the linked page.

**Collection**: The single user's complete set of bookmarks, including active
and archived bookmarks.

**Tag**: A flat, trimmed, case-insensitive label attached to a bookmark to help
organize and find it. Tags have no parent-child hierarchy.

**Active bookmark**: A bookmark that has not been archived and appears in the
default view.

**Archived bookmark**: A bookmark retained in the collection but hidden from
the active view. Archiving is reversible and does not mean deletion.

**Permanent deletion**: Removal of a bookmark from the collection after
confirmation, with no trash or in-app undo.

**Stash backup**: A versioned JSON export that preserves bookmark notes, tags,
timestamps, and archive status as well as links and titles.

**Duplicate bookmark**: A bookmark whose normalized URL matches one already in
the collection, including archived bookmarks. Query parameters and fragments
remain part of its identity.

**Merge import**: Addition of bookmarks not already in the collection, without
overwriting or unarchiving existing bookmarks. It does not replace the
collection.

**Browser-bookmark HTML**: A portable bookmark file used to exchange links and
titles with browsers. It is not a full-fidelity Stash backup.
