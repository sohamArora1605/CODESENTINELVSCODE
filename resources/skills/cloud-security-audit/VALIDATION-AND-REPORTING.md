# Phase 3 & 4: Validation & Reporting

Finding security issues is only half the battle. A professional security audit requires proving exploitability, eliminating false positives, calculating standardized CVSS 3.1 severity scores, and providing actionable remediation diffs.

---

## 1. False Positive Elimination Checklist

Before including any finding in the report, put it through this 4-step gauntlet:

1. **Reachability Check**:
   - Is the vulnerable function actually reachable from an external entrypoint?
   - Use `codesentinel_call_hierarchy` to trace backwards from the target function to active routes or event consumers. If no path exists from an entrypoint, downgrade to *Low/Informational* or discard.
2. **Sanitization / Validation Guard**:
   - Does any intermediary function perform type checking, allowlist validation, regex filtering, or encoding?
   - Trace the exact dataflow using `codesentinel_find_path`.
3. **Authentication Barrier**:
   - Is the route protected by authentication?
   - If an endpoint has an SSRF or injection vulnerability but is restricted to authorized super-administrators, the severity must reflect *High/Medium* rather than *Critical*.
4. **Environment Context**:
   - Is this code only executed in unit tests, build scripts, or mock utilities (`test/`, `spec/`, `scripts/`)?
   - Test files are not production vulnerabilities.

---

## 2. CVSS v3.1 Scoring Matrix

Calculate CVSS 3.1 base score metrics for each confirmed vulnerability:

- **Attack Vector (AV)**: Network (N), Adjacent (A), Local (L), Physical (P)
- **Attack Complexity (AC)**: Low (L), High (H)
- **Privileges Required (PR)**: None (N), Low (L), High (H)
- **User Interaction (UI)**: None (N), Required (R)
- **Scope (S)**: Unchanged (U), Changed (C)
- **Confidentiality (C)**: None (N), Low (L), High (H)
- **Integrity (I)**: None (N), Low (L), High (H)
- **Availability (A)**: None (N), Low (L), High (H)

### Severity Tiers:
- **Critical (9.0 - 10.0)**: Remote code execution, unauthenticated cloud IAM takeover, unauthenticated full database exfiltration.
- **High (7.0 - 8.9)**: Authenticated SSRF reaching IMDS, BOLA/IDOR allowing cross-tenant data alteration, wildcard IAM privilege escalation.
- **Medium (4.0 - 6.9)**: Hardcoded API keys with limited read permissions, presigned URLs without expiration, information disclosure.
- **Low (0.1 - 3.9)**: Missing security headers, verbose error messages in non-production environments.

---

## 3. Human-Readable Report Structure (`SECURITY-AUDIT-REPORT.md`)

The report must be written in markdown with this structure:

```markdown
# Cloud Security Audit Report

**Target Workspace**: [Repository Name]
**Audit Date**: [Date]
**Auditor**: CodeSentinel Agentic Auditor (OpenCode + Cloud Security Audit Skill)

## Executive Summary
[High-level overview of findings, overall security posture, and critical risk areas]

## Vulnerability Summary Table
| ID | Title | Severity | CVSS | CWE | Status |
|:---|:---|:---|:---|:---|:---|
| CS-01 | Unauthenticated SSRF to AWS IMDS | Critical | 9.8 | CWE-918 | Confirmed |

---

## Detailed Findings

### [CS-01] Unauthenticated SSRF via Image Download Endpoint

- **Severity**: Critical (CVSS 9.8 - `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)
- **CWE**: [CWE-918: Server-Side Request Forgery](https://cwe.mitre.org/data/definitions/918.html)
- **Affected File**: `src/controllers/mediaController.ts:42-56`
- **Taint Source**: `req.query.imageUrl`
- **Dangerous Sink**: `axios.get(targetUrl)`

#### Vulnerability Description
[Detailed technical explanation of the vulnerability]

#### Exploit Scenario & Proof of Concept
[Step-by-step attack scenario showing how an adversary can abuse this flaw to steal cloud credentials]

#### CodeSentinel Dataflow Trace
\`\`\`mermaid
flowchart LR
    A[req.query.imageUrl] --> B[mediaController.downloadMedia]
    B --> C[axios.get]
    C --> D[http://169.254.169.254/latest/meta-data/iam/security-credentials/]
\`\`\`

#### Remediation Diff
\`\`\`diff
- const response = await axios.get(req.query.imageUrl);
+ const safeUrl = validatePublicUrl(req.query.imageUrl);
+ const response = await axios.get(safeUrl);
\`\`\`
```

---

## 4. Machine-Readable Findings (`security-audit-report.json`)

Always write `security-audit-report.json` in the root of the workspace complying with `report-schema.json`.
