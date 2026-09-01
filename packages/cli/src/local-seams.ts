import { SEAM_KIND, type SeamKind } from '@memnox/core';
import {
  DOCKER_ACTIONS,
  DOCKER_BLIND_SPOTS,
  EGRESS_BLIND_SPOTS,
  EGRESS_CONNECT_ACTION,
  EGRESS_REQUEST_ACTION,
  GIT_BLIND_SPOTS,
  GIT_CREDENTIAL_ACTION,
  HOOK_BLIND_SPOTS,
  HOOK_COVERS,
  SHELL_ACTION,
  SHELL_BLIND_SPOTS,
} from '@memnox/tool-hook';

interface LocalSeamDeclaration {
  kind: SeamKind;
  covers: string[];
  blindTo: string[];
}

/**
 * Declared in one place because two commands install them: `memnox setup` and
 * `memnox hooks install`. A list kept in both drifts, and the half nobody updated
 * reports coverage the machine does not have.
 */
export const LOCAL_SEAMS: readonly LocalSeamDeclaration[] = [
  { kind: SEAM_KIND.HOOK, covers: [...HOOK_COVERS], blindTo: [...HOOK_BLIND_SPOTS] },
  { kind: SEAM_KIND.SHELL, covers: [SHELL_ACTION], blindTo: [...SHELL_BLIND_SPOTS] },
  {
    kind: SEAM_KIND.GIT,
    covers: [GIT_CREDENTIAL_ACTION],
    blindTo: [...GIT_BLIND_SPOTS],
  },
  {
    kind: SEAM_KIND.EGRESS,
    covers: [EGRESS_REQUEST_ACTION, EGRESS_CONNECT_ACTION],
    blindTo: [...EGRESS_BLIND_SPOTS],
  },
  {
    kind: SEAM_KIND.DOCKER,
    covers: [...DOCKER_ACTIONS],
    blindTo: [...DOCKER_BLIND_SPOTS],
  },
];
