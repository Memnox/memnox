/**
 * git and the working tree now live in core, so a seam keeps milestones with the same
 * adapter `rewind` restores them with. Re-exported where the commands already import it.
 */
export { NodeGit, NodeWorktree } from '@memnox/core';
