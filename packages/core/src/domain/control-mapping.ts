/**
 * Self-assessed control readiness, as code.
 *
 * This is NOT a certification and must never be rendered as one. SOC 2 and ISO
 * 27001 are an auditor's opinion and a certificate; HIPAA and GDPR have no
 * certification at all. What this records is which controls exist, where the
 * evidence lives, and — the part that matters — what is still missing.
 */

export const FRAMEWORK = {
  SOC2: 'soc2',
  ISO_27001: 'iso27001',
  HIPAA: 'hipaa',
  GDPR: 'gdpr',
} as const;

export type Framework = (typeof FRAMEWORK)[keyof typeof FRAMEWORK];

export const CONTROL_STATUS = {
  /** Shipped, with a test or code path that demonstrates it. */
  IMPLEMENTED: 'implemented',
  /** Partly shipped; the gap says what is missing. */
  PARTIAL: 'partial',
  /** Not built. */
  PLANNED: 'planned',
  /** Cannot be code — policy, contract, or an auditor's opinion. */
  ORGANIZATIONAL: 'organizational',
} as const;

export type ControlStatus = (typeof CONTROL_STATUS)[keyof typeof CONTROL_STATUS];

export interface ControlMapping {
  /** The framework's own reference, e.g. "CC6.1" or "Art. 17". */
  reference: string;
  framework: Framework;
  requirement: string;
  status: ControlStatus;
  /** Paths or commands a reviewer can check. Required once anything is claimed. */
  evidence: readonly string[];
  /** What is missing. Required for anything not fully implemented. */
  gap?: string;
}

const RUNTIME = 'memnox-runtime';
const CLOUD = 'memnox-cloud';

export const CONTROL_MAPPINGS: readonly ControlMapping[] = [
  // ---- SOC 2 Trust Services Criteria ----
  {
    reference: 'CC6.1',
    framework: FRAMEWORK.SOC2,
    requirement: 'Logical access controls restrict access to authorized users.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${RUNTIME}/packages/runtime/src/auth.ts`,
      `${CLOUD}/src/auth/cloud-auth.guard.ts`,
      `${RUNTIME}/packages/runtime/test/auth.test.ts`,
    ],
    gap: 'The cloud route guard treats a missing role annotation as public, so a new controller method is public by default. No boot-time assertion enumerates unguarded routes.',
  },
  {
    reference: 'CC6.6',
    framework: FRAMEWORK.SOC2,
    requirement: 'Encryption protects data in transit.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${CLOUD}/src/main.ts`],
    gap: 'Neither service terminates TLS. HSTS is emitted on a connection the app cannot verify was TLS, and no reference terminator config ships.',
  },
  {
    reference: 'CC6.7',
    framework: FRAMEWORK.SOC2,
    requirement: 'Encryption protects data at rest.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${RUNTIME}/packages/runtime/src/stores/keyring-codec.ts`,
      `${RUNTIME}/packages/runtime/test/keyring-codec.test.ts`,
      `${RUNTIME}/packages/runtime/test/key-rewrap.test.ts`,
      `${CLOUD}/test/encryption-coverage.test.ts`,
    ],
    gap: 'Every table holding identity or content is encrypted; person_identities.external_id stays readable as a lookup key, and vectors and identifier columns are plaintext by design (see ARCHITECTURE.md). Encryption is still opt-in.',
  },
  {
    reference: 'CC7.2',
    framework: FRAMEWORK.SOC2,
    requirement: 'Anomalies are monitored and detected.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/packages/runtime/src/metrics.ts`],
    gap: 'Counters only — no gauges or histograms, so no latency or error-rate SLI. No alerting, and no evidence of alert acknowledgement.',
  },
  {
    reference: 'CC7.3',
    framework: FRAMEWORK.SOC2,
    requirement: 'Security events are evaluated and acted on.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/SECURITY.md`],
    gap: 'External vulnerability disclosure has an SLA; there is no internal incident-response runbook, severity ladder, or on-call rotation.',
  },
  {
    reference: 'CC7.1',
    framework: FRAMEWORK.SOC2,
    requirement: 'Vulnerabilities are identified and remediated.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${RUNTIME}/.github/workflows/security.yml`,
      `${RUNTIME}/packages/content-shield/src/scanner.ts`,
    ],
    gap: 'SBOM is produced per run but not signed or attached to a release.',
  },
  {
    reference: 'CC8.1',
    framework: FRAMEWORK.SOC2,
    requirement: 'Changes are authorized, tested, and approved before deployment.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${RUNTIME}/.github/workflows/ci.yml`,
      `${RUNTIME}/.github/workflows/release.yml`,
      `${RUNTIME}/CONTRIBUTING.md`,
    ],
    gap: 'No enforced branch protection, required reviews, or per-release evidence bundle recording who approved what.',
  },
  {
    reference: 'A1.2',
    framework: FRAMEWORK.SOC2,
    requirement: 'Backups are taken and recoverability is tested.',
    status: CONTROL_STATUS.PLANNED,
    evidence: [],
    gap: 'No backup story at all, and therefore no restore drill. An untested backup is not a control.',
  },
  {
    reference: 'CC1.4',
    framework: FRAMEWORK.SOC2,
    requirement: 'Personnel are screened, trained, and bound by policy.',
    status: CONTROL_STATUS.ORGANIZATIONAL,
    evidence: [],
    gap: 'Policy and HR process; a compliance-automation platform covers this.',
  },

  // ---- ISO/IEC 27001:2022 Annex A ----
  {
    reference: 'A.5.1',
    framework: FRAMEWORK.ISO_27001,
    requirement: 'Information security policies are defined and approved.',
    status: CONTROL_STATUS.ORGANIZATIONAL,
    evidence: [`${RUNTIME}/SECURITY.md`],
    gap: 'A vulnerability policy exists. There is no ISMS, no risk register, and no Statement of Applicability.',
  },
  {
    reference: 'A.8.24',
    framework: FRAMEWORK.ISO_27001,
    requirement: 'Cryptography is governed by a policy, including key management.',
    status: CONTROL_STATUS.IMPLEMENTED,
    evidence: [
      `${RUNTIME}/packages/runtime/src/stores/keyring-codec.ts`,
      `${RUNTIME}/packages/cli/src/commands/keys.command.ts`,
      `${RUNTIME}/ARCHITECTURE.md`,
    ],
  },
  {
    reference: 'A.8.15',
    framework: FRAMEWORK.ISO_27001,
    requirement: 'Logs record activities and are protected from tampering.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${RUNTIME}/packages/core/src/domain/audit-chain.ts`,
      `${RUNTIME}/packages/runtime/test/audit-chain.test.ts`,
    ],
    gap: 'The decision log is hash-chained, but application logs are unstructured strings with no request id. Front-truncation of the chain is undetectable.',
  },
  {
    reference: 'A.8.16',
    framework: FRAMEWORK.ISO_27001,
    requirement: 'Networks and systems are monitored for anomalous behaviour.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/packages/risk/src/behavior-advisor.ts`],
    gap: 'Agent behaviour is monitored; the platform itself is not. No alerting.',
  },
  {
    reference: 'A.5.30',
    framework: FRAMEWORK.ISO_27001,
    requirement: 'ICT readiness for business continuity.',
    status: CONTROL_STATUS.PLANNED,
    evidence: [],
    gap: 'No backup, restore drill, or continuity plan.',
  },

  // ---- HIPAA Security Rule ----
  {
    reference: '§164.312(a)(2)(iv)',
    framework: FRAMEWORK.HIPAA,
    requirement: 'Encryption of ePHI at rest (addressable).',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/packages/runtime/src/stores/keyring-codec.ts`],
    gap: 'Addressable specifications require a documented risk analysis justifying the implementation; none exists.',
  },
  {
    reference: '§164.312(b)',
    framework: FRAMEWORK.HIPAA,
    requirement: 'Audit controls record activity in systems holding ePHI.',
    status: CONTROL_STATUS.IMPLEMENTED,
    evidence: [
      `${RUNTIME}/packages/core/src/domain/audit-chain.ts`,
      'memnox audit verify',
    ],
  },
  {
    reference: '§164.502(b)',
    framework: FRAMEWORK.HIPAA,
    requirement: 'Minimum necessary use and disclosure.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/packages/policy-engine/src/policy-packs.ts`],
    gap: 'PHI policy packs exist but are inert: no transport sets dataClassification, and the residency rules deny by named jurisdiction so an unlisted region is allowed.',
  },
  {
    reference: '§164.308(a)(1)',
    framework: FRAMEWORK.HIPAA,
    requirement: 'Security management process, including risk analysis.',
    status: CONTROL_STATUS.ORGANIZATIONAL,
    evidence: [],
    gap: 'No risk analysis, sanction policy, or workforce training.',
  },
  {
    reference: 'BAA',
    framework: FRAMEWORK.HIPAA,
    requirement: 'A Business Associate Agreement is executed with each covered entity.',
    status: CONTROL_STATUS.ORGANIZATIONAL,
    evidence: [],
    gap: 'No BAA. Without one, no HIPAA claim of any kind may be published.',
  },

  // ---- GDPR ----
  {
    reference: 'Art. 30',
    framework: FRAMEWORK.GDPR,
    requirement: 'Records of processing activities are maintained.',
    status: CONTROL_STATUS.IMPLEMENTED,
    evidence: [
      `${CLOUD}/src/privacy/data-inventory.ts`,
      `${CLOUD}/test/data-inventory.test.ts`,
    ],
  },
  {
    reference: 'Art. 15',
    framework: FRAMEWORK.GDPR,
    requirement: 'Data subjects can obtain a copy of their personal data.',
    status: CONTROL_STATUS.IMPLEMENTED,
    evidence: [
      `${CLOUD}/src/privacy/postgres-subject-store.ts`,
      `${CLOUD}/test/subject-rights.test.ts`,
    ],
  },
  {
    reference: 'Art. 17',
    framework: FRAMEWORK.GDPR,
    requirement: 'Data subjects can obtain erasure of their personal data.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [
      `${CLOUD}/src/privacy/postgres-subject-store.ts`,
      `${CLOUD}/src/privacy/tenant-purge.store.ts`,
      `${CLOUD}/test/subject-rights.test.ts`,
      `${CLOUD}/test/privacy-retention.test.ts`,
    ],
    gap: 'Erasure and the org/workspace purge cascade ship. Chained audit evidence refuses erasure because crypto-shredding needs a per-subject key that is not written yet.',
  },
  {
    reference: 'Art. 32',
    framework: FRAMEWORK.GDPR,
    requirement: 'Security appropriate to the risk, including encryption.',
    status: CONTROL_STATUS.PARTIAL,
    evidence: [`${RUNTIME}/packages/runtime/src/stores/keyring-codec.ts`],
    gap: 'Encryption at rest is opt-in. No TLS termination ships.',
  },
  {
    reference: 'Art. 5(1)(e)',
    framework: FRAMEWORK.GDPR,
    requirement: 'Personal data is kept no longer than necessary.',
    status: CONTROL_STATUS.IMPLEMENTED,
    evidence: [
      `${RUNTIME}/packages/runtime/src/audit-retention.ts`,
      `${CLOUD}/src/privacy/retention.store.ts`,
      `${CLOUD}/test/privacy-retention.test.ts`,
    ],
  },
  {
    reference: 'Art. 28',
    framework: FRAMEWORK.GDPR,
    requirement: 'A processor agreement governs processing on behalf of a controller.',
    status: CONTROL_STATUS.ORGANIZATIONAL,
    evidence: [],
    gap: 'No DPA, no subprocessor list, no privacy notice.',
  },
  {
    reference: 'Art. 33',
    framework: FRAMEWORK.GDPR,
    requirement: 'Personal data breaches are notified within 72 hours.',
    status: CONTROL_STATUS.PLANNED,
    evidence: [],
    gap: 'No breach-notification runbook.',
  },
];

export function controlsFor(framework: Framework): readonly ControlMapping[] {
  return CONTROL_MAPPINGS.filter((control) => control.framework === framework);
}

export interface ReadinessSummary {
  framework: Framework;
  implemented: number;
  partial: number;
  planned: number;
  organizational: number;
}

export function readinessFor(framework: Framework): ReadinessSummary {
  const controls = controlsFor(framework);
  const count = (status: ControlStatus): number =>
    controls.filter((control) => control.status === status).length;
  return {
    framework,
    implemented: count(CONTROL_STATUS.IMPLEMENTED),
    partial: count(CONTROL_STATUS.PARTIAL),
    planned: count(CONTROL_STATUS.PLANNED),
    organizational: count(CONTROL_STATUS.ORGANIZATIONAL),
  };
}
