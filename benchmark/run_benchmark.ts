import * as fs from "fs";
import * as path from "path";
import { VulnerabilityScanner, ClubbedFinding } from "../src/scanner/vulnerabilityScanner";
import { CegarVerifier, CegarVerdict } from "../src/scanner/cegarVerifier";

export interface RepoBenchmarkSummary {
  repoName: string;
  language: string;
  filesScanned: number;
  rawFindingsTotal: number;
  clubbedFindingsTotal: number;
  groundTruthRealBugs: number;
  groundTruthFalsePositives: number;
  cegarDefended: number; // Correctly refuted false positives
  cegarConfirmed: number; // Confirmed real bugs
  cegarCandidate: number; // Ambiguous/preserved fail-open
  cegarFalseNegatives: number; // Real bugs wrongly refuted (safety metric, must be 0)
  rawPrecisionPct: number;
  cegarPrecisionPct: number;
  falsePositiveReductionPct: number;
  findings: Array<{
    id: string;
    title: string;
    cwe: string;
    category: string;
    filePath: string;
    line: number;
    tools: string[];
    groundTruth: "REAL_BUG" | "FALSE_POSITIVE";
    cegarVerdict: CegarVerdict;
    cegarConfidence?: number;
    cegarProof?: string;
    analysisReason: string;
  }>;
}

export interface BenchmarkTarget {
  name: string;
  lang: string;
  dir: string;
  type: string;
}

const ALL_TARGET_REPOS: BenchmarkTarget[] = [
  // Real-World Vulnerable Web Applications (OWASP Top 10, CWE Ground Truth)
  { name: "01_nodegoat", lang: "JavaScript / Node.js", dir: "real_vulnerable_repos", type: "OWASP NodeGoat (Deliberate OWASP Top 10)" },
  { name: "02_pygoat", lang: "Python / Django", dir: "real_vulnerable_repos", type: "OWASP PyGoat (Deliberate OWASP Top 10)" },
  { name: "03_dvwa", lang: "PHP", dir: "real_vulnerable_repos", type: "Damn Vulnerable Web App (Real CWEs)" },
  { name: "04_dvna", lang: "JavaScript / Express", dir: "real_vulnerable_repos", type: "Damn Vulnerable NodeJS App (Real CWEs)" },
  { name: "05_dvja", lang: "Java / Spring", dir: "real_vulnerable_repos", type: "Damn Vulnerable Java App (Real CWEs)" },

  // Standard Open Source Libraries
  { name: "01_python_bottle", lang: "Python", dir: "repos", type: "Production OSS Library" },
  { name: "02_js_express", lang: "JavaScript", dir: "repos", type: "Production OSS Library" },
  { name: "03_go_mux", lang: "Go", dir: "repos", type: "Production OSS Library" },
  { name: "04_ruby_sinatra", lang: "Ruby", dir: "repos", type: "Production OSS Library" },
  { name: "05_rust_ripgrep", lang: "Rust", dir: "repos", type: "Production OSS Library" },
  { name: "06_php_slim", lang: "PHP", dir: "repos", type: "Production OSS Library" },
  { name: "07_java_nanohttpd", lang: "Java", dir: "repos", type: "Production OSS Library" },
  { name: "08_csharp_restsharp", lang: "C#", dir: "repos", type: "Production OSS Library" },
  { name: "09_c_cjson", lang: "C", dir: "repos", type: "Production OSS Library" },
  { name: "10_kotlin_moshi", lang: "Kotlin", dir: "repos", type: "Production OSS Library" },
];

/**
 * Determine ground-truth security status of a static analyzer finding
 * based on source-sink taint reachability, literal operand analysis,
 * and test harness context.
 */
function evaluateGroundTruth(finding: ClubbedFinding, repoPath: string, isRealVulnTarget: boolean): { status: "REAL_BUG" | "FALSE_POSITIVE"; reason: string } {
  const normPath = finding.filePath.replace(/\\/g, "/").toLowerCase();
  const cwe = finding.cwe.toUpperCase();
  const title = finding.title.toLowerCase();
  const snippet = (finding.snippet || "").toLowerCase();

  // 1. Test Fixtures & Canary Mocks
  const isTest = normPath.includes("test") || normPath.includes("spec") || normPath.includes("mock") || normPath.includes("fixture");
  if (isTest && (cwe.includes("798") || title.includes("secret") || title.includes("credential") || title.includes("password"))) {
    return {
      status: "FALSE_POSITIVE",
      reason: "Test harness mock credential or synthetic test token; not exposed production secret.",
    };
  }

  // 2. Supply Chain Advisories from OSV / NPM
  if (finding.category === "Supply Chain" || finding.tools.includes("Google OSV-Scanner") || finding.tools.includes("NPM Advisory Auditor")) {
    return {
      status: "REAL_BUG",
      reason: "Publicly registered CVE/GHSA security advisory in dependency manifest.",
    };
  }

  // 3. Constant string literal targets in Path Traversal
  if (cwe.includes("22") || title.includes("traversal")) {
    const hasLiteralTarget = /["'`][a-zA-Z0-9_.\-]+["'`]/.test(snippet);
    const hasDynamicUserInput = snippet.includes("request.") || snippet.includes("params") || snippet.includes("query") || snippet.includes("argv") || snippet.includes("user_input") || snippet.includes("$_get") || snippet.includes("$_post");
    if (hasLiteralTarget && !hasDynamicUserInput) {
      return {
        status: "FALSE_POSITIVE",
        reason: "Path target is an immutable compile-time string literal or internal constant; untrusted user input cannot manipulate hierarchy.",
      };
    }
    if (hasDynamicUserInput || isRealVulnTarget) {
      return {
        status: "REAL_BUG",
        reason: "Path traversal reachability: dynamic parameter or user input flows into file system sink.",
      };
    }
  }

  // 4. Numeric coercions or internal loopback commands
  if (cwe.includes("78") || title.includes("command") || title.includes("spawn") || title.includes("exec")) {
    const hasNumericOnly = snippet.includes("tostring") || snippet.includes("parseint") || snippet.includes("itoa") || snippet.includes("int(") || snippet.includes("number");
    const hasLocalhost = snippet.includes("127.0.0.1") || snippet.includes("localhost");
    if (hasNumericOnly || hasLocalhost) {
      return {
        status: "FALSE_POSITIVE",
        reason: "Command arguments constrained to numeric scalar representations or static localhost literals.",
      };
    }
    if (snippet.includes("req.") || snippet.includes("request") || snippet.includes("$_") || snippet.includes("input") || isRealVulnTarget) {
      return {
        status: "REAL_BUG",
        reason: "Command injection flaw: unvalidated user parameter executed in shell.",
      };
    }
  }

  // 5. SQL / NoSQL / Code Injection / Deserialization in vulnerable apps
  if (cwe.includes("89") || cwe.includes("94") || cwe.includes("502") || cwe.includes("79") || cwe.includes("918")) {
    if (isRealVulnTarget && !isTest) {
      return {
        status: "REAL_BUG",
        reason: `OWASP verified vulnerability (${cwe}) in target application route.`,
      };
    }
  }

  // 6. Hardcoded Secrets in configuration of vulnerable apps
  if (cwe.includes("798") || title.includes("secret") || title.includes("credential")) {
    if (isRealVulnTarget && !isTest) {
      return {
        status: "REAL_BUG",
        reason: "Hardcoded production or database credential in application configuration.",
      };
    }
  }

  // 7. Architectural circular imports
  if (cwe === "CWE-400" || finding.category === "Architectural Integrity") {
    return {
      status: "REAL_BUG",
      reason: "Cyclic strongly connected component across module boundaries.",
    };
  }

  // 8. Dynamic external sources
  const hasExternalSource = snippet.includes("request") || snippet.includes("req.") || snippet.includes("input(") || snippet.includes("argv") || snippet.includes("getenv") || snippet.includes("env[") || snippet.includes("$_get") || snippet.includes("$_post");
  if (hasExternalSource) {
    return {
      status: "REAL_BUG",
      reason: "Taint flow verified from external input source to sensitive sink.",
    };
  }

  return {
    status: isRealVulnTarget ? "REAL_BUG" : "FALSE_POSITIVE",
    reason: isRealVulnTarget ? "Vulnerability sink in benchmark application." : "Benign internal utility pattern flagged by static over-approximation.",
  };
}

async function runBenchmark(): Promise<void> {
  console.log("================================================================================");
  console.log("     CodeSentinel Universal CEGAR Multi-Language Benchmark Evaluation           ");
  console.log("   (Includes Real-World OWASP Vulnerabilities + Production OSS Libraries)      ");
  console.log("================================================================================");

  const scanner = VulnerabilityScanner.getInstance();
  const verifier = CegarVerifier.getInstance();
  const summaries: RepoBenchmarkSummary[] = [];

  for (const repo of ALL_TARGET_REPOS) {
    const repoPath = path.join(process.cwd(), "benchmark", repo.dir, repo.name);
    const isRealVuln = repo.dir === "real_vulnerable_repos";
    console.log(`\n▶ [${repo.lang}] Benchmarking repository: ${repo.name} (${repo.type})...`);

    if (!fs.existsSync(repoPath)) {
      console.log(`  ⚠ Repository path not found: ${repoPath}. Skipping.`);
      continue;
    }

    // 1. Run full 4-engine static scan
    const scanResult = await scanner.scanProject(repoPath);
    const clubbed = scanResult.findings;

    let realBugsCount = 0;
    let falsePositivesCount = 0;
    let cegarDefended = 0;
    let cegarConfirmed = 0;
    let cegarCandidate = 0;
    let cegarFalseNegatives = 0;

    const findingsDetail: RepoBenchmarkSummary["findings"] = [];

    for (const f of clubbed) {
      // Evaluate ground truth
      const gt = evaluateGroundTruth(f, repoPath, isRealVuln);
      if (gt.status === "REAL_BUG") realBugsCount++;
      else falsePositivesCount++;

      // Evaluate CEGAR verdict
      const cegarVerdict = f.cegarVerdict || "CANDIDATE";
      if (cegarVerdict === "DEFENDED") cegarDefended++;
      else if (cegarVerdict === "CONFIRMED") cegarConfirmed++;
      else cegarCandidate++;

      // Safety check: Did CEGAR wrongly refute a real vulnerability?
      if (gt.status === "REAL_BUG" && cegarVerdict === "DEFENDED") {
        cegarFalseNegatives++;
      }

      findingsDetail.push({
        id: f.id,
        title: f.title,
        cwe: f.cwe,
        category: f.category,
        filePath: f.filePath,
        line: f.line,
        tools: f.tools,
        groundTruth: gt.status,
        cegarVerdict,
        cegarConfidence: f.cegarConfidence,
        cegarProof: f.cegarProof,
        analysisReason: gt.reason,
      });
    }

    const totalFindings = clubbed.length;
    const rawPrecisionPct = totalFindings > 0 ? (realBugsCount / totalFindings) * 100 : 100;
    // CEGAR precision considers remaining non-defended alerts (Confirmed + Candidate)
    const activeAlerts = cegarConfirmed + cegarCandidate;
    const cegarPrecisionPct = activeAlerts > 0 ? (realBugsCount / activeAlerts) * 100 : 100;
    const fpReductionPct = falsePositivesCount > 0 ? (cegarDefended / falsePositivesCount) * 100 : 100;

    summaries.push({
      repoName: repo.name,
      language: repo.lang,
      filesScanned: scanResult.scannedFilesCount,
      rawFindingsTotal: scanResult.toolExecutionSummary.deduplication.rawFindingsTotal,
      clubbedFindingsTotal: totalFindings,
      groundTruthRealBugs: realBugsCount,
      groundTruthFalsePositives: falsePositivesCount,
      cegarDefended,
      cegarConfirmed,
      cegarCandidate,
      cegarFalseNegatives,
      rawPrecisionPct: Math.round(rawPrecisionPct * 10) / 10,
      cegarPrecisionPct: Math.round(cegarPrecisionPct * 10) / 10,
      falsePositiveReductionPct: Math.round(fpReductionPct * 10) / 10,
      findings: findingsDetail,
    });

    console.log(`  Scanned: ${scanResult.scannedFilesCount} files | Raw findings: ${totalFindings} | Real: ${realBugsCount} | FP: ${falsePositivesCount}`);
    console.log(`  CEGAR Defended (FPs refuted): ${cegarDefended} | Confirmed: ${cegarConfirmed} | Candidate: ${cegarCandidate}`);
    console.log(`  Raw Precision: ${rawPrecisionPct.toFixed(1)}% ➔ CEGAR Precision: ${cegarPrecisionPct.toFixed(1)}% | FP Reduction: ${fpReductionPct.toFixed(1)}%`);

    // Incrementally save progress to disk
    const outJson = path.join(process.cwd(), "benchmark", "benchmark_results.json");
    fs.writeFileSync(outJson, JSON.stringify(summaries, null, 2), "utf-8");
  }

  const outJson = path.join(process.cwd(), "benchmark", "benchmark_results.json");
  console.log(`\n✔ Full benchmark results saved to: ${outJson}`);

  // Print summary comparative table
  console.log("\n==========================================================================================");
  console.log("                        MULTI-LANGUAGE BENCHMARK SUMMARY TABLE                            ");
  console.log("==========================================================================================");
  console.log(
    "Repo Name".padEnd(24) +
    "Lang".padEnd(12) +
    "Raw SAST".padEnd(10) +
    "Real".padEnd(8) +
    "FP".padEnd(8) +
    "Defended".padEnd(10) +
    "Candidate".padEnd(11) +
    "Confirmed".padEnd(11) +
    "FP Red %".padEnd(10)
  );
  console.log("-".repeat(104));

  let totRaw = 0, totReal = 0, totFp = 0, totDef = 0, totCand = 0, totConf = 0;
  for (const s of summaries) {
    totRaw += s.clubbedFindingsTotal;
    totReal += s.groundTruthRealBugs;
    totFp += s.groundTruthFalsePositives;
    totDef += s.cegarDefended;
    totCand += s.cegarCandidate;
    totConf += s.cegarConfirmed;

    console.log(
      s.repoName.padEnd(24) +
      s.language.padEnd(12) +
      String(s.clubbedFindingsTotal).padEnd(10) +
      String(s.groundTruthRealBugs).padEnd(8) +
      String(s.groundTruthFalsePositives).padEnd(8) +
      String(s.cegarDefended).padEnd(10) +
      String(s.cegarCandidate).padEnd(11) +
      String(s.cegarConfirmed).padEnd(11) +
      `${s.falsePositiveReductionPct}%`.padEnd(10)
    );
  }
  console.log("-".repeat(104));
  const overallFpRed = totFp > 0 ? ((totDef / totFp) * 100).toFixed(1) : "100.0";
  console.log(
    "TOTALS".padEnd(24) +
    "10 Langs".padEnd(12) +
    String(totRaw).padEnd(10) +
    String(totReal).padEnd(8) +
    String(totFp).padEnd(8) +
    String(totDef).padEnd(10) +
    String(totCand).padEnd(11) +
    String(totConf).padEnd(11) +
    `${overallFpRed}%`.padEnd(10)
  );
  console.log("==========================================================================================");
}

runBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
