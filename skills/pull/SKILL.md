---
name: pull
description: Pull the current Git repository once and report the result. Use only when the user explicitly invokes this skill or asks to pull the repository.
disable-model-invocation: true
---

# Pull the current Git repository

1. Confirm the current directory is inside a Git repository with a read-only Git command. If it is not, stop and report that state.
2. From the repository root, run `git pull` exactly once. Do not stash, reset, clean, switch branches, edit files, or otherwise prepare the repository first.
3. If the pull succeeds, report the result concisely.
4. If the pull fails for any reason, including a merge or rebase conflict, stop immediately. Use only read-only commands such as `git status --short --branch` to report the repository state and tell the user to fix it manually.

After a failure, never retry the pull or attempt to resolve, continue, skip, or abort a merge or rebase. Do not modify files, refs, the index, or the working tree.
