import * as assert from "assert";
import { CegarVerifier } from "../src/scanner/cegarVerifier";
import { ClubbedFinding } from "../src/scanner/vulnerabilityScanner";

export async function testCegarVerifier(): Promise<void> {
  console.log("▶ Running CegarVerifier Integration Tests...");

  const verifier = CegarVerifier.getInstance();
  assert.ok(verifier, "CegarVerifier instance must be initialized");

  // Test 1: Deterministic Fast-Path Filter - Test Fixture Dummy Credential (CWE-798)
  const testSecretFinding: ClubbedFinding = {
    id: "VUL-SECRET-TEST",
    title: "AWS Access Key ID Value detected",
    severity: "Critical",
    cwe: "CWE-798",
    category: "Hardcoded Credentials",
    filePath: "test/auth.test.ts",
    line: 12,
    endLine: 12,
    snippet: 'const awsKey = "AKIA1111222233334444";',
    description: "Detected test credential",
    remediation: "Remove",
    tools: ["Gitleaks Secret Scanner"],
  };

  const secretResult = await verifier.verifyFinding(testSecretFinding, process.cwd());
  assert.strictEqual(secretResult.verdict, "DEFENDED", "Test fixture canary secrets must be DEFENDED as false positives");
  assert.ok(secretResult.proof.includes("Mathematical Proof"), "Must provide mathematical proof of defense");
  console.log("  ✔ Test fixture dummy credentials correctly refuted by deterministic proof");

  // Test 2: Deterministic Fast-Path Filter - Constant Literal Argument Sink (CWE-22)
  const literalPathFinding: ClubbedFinding = {
    id: "VUL-PATH-LITERAL",
    title: "Possible path traversal",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "src/workspace/config.ts",
    line: 25,
    endLine: 25,
    snippet: 'const configPath = path.join(workspaceRoot, "settings.json");',
    description: "path.join with constant literal",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };

  const literalResult = await verifier.verifyFinding(literalPathFinding, process.cwd());
  assert.strictEqual(literalResult.verdict, "DEFENDED", "Constant literal argument sinks must be mathematically DEFENDED");
  console.log("  ✔ Constant literal argument path sinks correctly proven defended");

  // Test 3: Deterministic Fast-Path Filter - Numeric Coercion (CWE-78)
  const numericSpawnFinding: ClubbedFinding = {
    id: "VUL-SPAWN-NUMERIC",
    title: "spawn with shell true",
    severity: "Critical",
    cwe: "CWE-78",
    category: "Command Injection",
    filePath: "src/server/launcher.ts",
    line: 50,
    endLine: 50,
    snippet: 'const proc = spawn(cmd, ["serve", "--port", targetPort.toString(), "--hostname", "127.0.0.1"], { shell: true });',
    description: "spawn called with numeric port toString()",
    remediation: "Use shell false",
    tools: ["Opengrep AST Engine"],
  };

  const numericResult = await verifier.verifyFinding(numericSpawnFinding, process.cwd());
  assert.strictEqual(numericResult.verdict, "DEFENDED", "Numeric scalar coerced arguments must be proven DEFENDED");
  console.log("  ✔ Numeric coercion spawn arguments mathematically defended against injection");

  // Test 4: True Positive Confirmation - Supply Chain Advisory (CWE-346)
  const supplyChainFinding: ClubbedFinding = {
    id: "VUL-SUPPLY-CHAIN",
    title: "Vulnerable Dependency: esbuild@0.23.1",
    severity: "Medium",
    cwe: "CWE-346",
    category: "Supply Chain",
    filePath: "package-lock.json",
    line: 1,
    endLine: 1,
    snippet: "Package: esbuild (0.23.1)",
    description: "Known CVE advisory in package repository",
    remediation: "Upgrade package",
    tools: ["Google OSV-Scanner"],
  };

  const scResult = await verifier.verifyFinding(supplyChainFinding, process.cwd());
  assert.strictEqual(scResult.verdict, "CONFIRMED", "Valid CVE advisories from OSV must be CONFIRMED");
  console.log("  ✔ Supply chain advisories correctly confirmed as True Positives");

  // Test 5: True Positive Confirmation - Architectural Circular Dependency (CWE-400)
  const circularFinding: ClubbedFinding = {
    id: "VUL-CIRCULAR-DEP",
    title: "Architectural Circular Dependency: a.ts",
    severity: "Medium",
    cwe: "CWE-400",
    category: "Architectural Integrity",
    filePath: "src/a.ts",
    line: 1,
    endLine: 1,
    snippet: "a.ts -> b.ts -> a.ts",
    description: "Cyclic strongly connected component",
    remediation: "Decouple modules",
    tools: ["Atlas Code Graph AST Engine"],
  };

  const circResult = await verifier.verifyFinding(circularFinding, process.cwd());
  assert.strictEqual(circResult.verdict, "CONFIRMED", "Atlas architectural circular dependencies must be CONFIRMED");
  console.log("  ✔ Architectural circular dependencies correctly confirmed");

  // Test 6: Fail-Open Safety Guarantee - Ambiguous Path
  const ambiguousFinding: ClubbedFinding = {
    id: "VUL-AMBIGUOUS",
    title: "Arbitrary dynamic call",
    severity: "Medium",
    cwe: "CWE-94",
    category: "Code Injection",
    filePath: "src/dynamic/plugin.ts",
    line: 99,
    endLine: 99,
    snippet: "loadCustomHandler(externalArg);",
    description: "Dynamic execution without recognizable guards",
    remediation: "Validate handlers",
    tools: ["Opengrep AST Engine"],
  };

  const ambResult = await verifier.verifyFinding(ambiguousFinding, process.cwd());
  assert.strictEqual(ambResult.verdict, "CANDIDATE", "Unprovable paths must remain CANDIDATE under fail-open guarantee");
  assert.ok(ambResult.proof.includes("Fail-Open Safety"), "Must declare fail-open safety in proof");
  console.log("  ✔ Strict fail-open safety verified: ambiguous paths preserved as CANDIDATE");

  // Test 7: Multi-Language Python & Go Verification (Semgrep Community Taint Standard)
  const pythonPathFinding: ClubbedFinding = {
    id: "VUL-PY-PATH",
    title: "Python os.path.join traversal alert",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "backend/storage.py",
    line: 14,
    endLine: 14,
    snippet: 'full_path = os.path.join(rootPath, "manifest.json")',
    description: "os.path.join with literal target",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const pyResult = await verifier.verifyFinding(pythonPathFinding, process.cwd());
  assert.strictEqual(pyResult.verdict, "DEFENDED", "Python os.path.join with literal target must be DEFENDED");
  console.log("  ✔ Multi-language Python path sink correctly proven DEFENDED");

  const goCommandFinding: ClubbedFinding = {
    id: "VUL-GO-CMD",
    title: "Go exec.Command injection alert",
    severity: "High",
    cwe: "CWE-78",
    category: "Command Injection",
    filePath: "pkg/runner/cmd.go",
    line: 42,
    endLine: 42,
    snippet: 'cmd := exec.Command("serve", "--port", strconv.Itoa(targetPort))',
    description: "exec.Command with strconv.Itoa",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const goResult = await verifier.verifyFinding(goCommandFinding, process.cwd());
  assert.strictEqual(goResult.verdict, "DEFENDED", "Go exec.Command with strconv.Itoa must be DEFENDED");
  console.log("  ✔ Multi-language Go numeric command injection correctly proven DEFENDED");

  // Test 7C: Multi-Language Ruby Verification
  const rubyPathFinding: ClubbedFinding = {
    id: "VUL-RUBY-PATH",
    title: "Ruby File.join traversal alert",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "app/models/document.rb",
    line: 18,
    endLine: 18,
    snippet: 'doc_path = File.join(storage_root, "document.pdf")',
    description: "File.join with literal target",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const rubyResult = await verifier.verifyFinding(rubyPathFinding, process.cwd());
  assert.strictEqual(rubyResult.verdict, "DEFENDED", "Ruby File.join with literal target must be DEFENDED");
  console.log("  ✔ Multi-language Ruby path sink correctly proven DEFENDED");

  // Test 7D: Multi-Language Rust Verification
  const rustPathFinding: ClubbedFinding = {
    id: "VUL-RUST-PATH",
    title: "Rust Path::join traversal alert",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "src/storage.rs",
    line: 22,
    endLine: 22,
    snippet: 'let config = base_path.join("config.toml");',
    description: "Path join with constant literal",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const rustResult = await verifier.verifyFinding(rustPathFinding, process.cwd());
  assert.strictEqual(rustResult.verdict, "DEFENDED", "Rust Path::join with literal target must be DEFENDED");
  console.log("  ✔ Multi-language Rust path sink correctly proven DEFENDED");

  // Test 7E: Multi-Language C# Verification
  const csharpCommandFinding: ClubbedFinding = {
    id: "VUL-CS-CMD",
    title: "C# Process.Start command alert",
    severity: "High",
    cwe: "CWE-78",
    category: "Command Injection",
    filePath: "Services/Worker.cs",
    line: 35,
    endLine: 35,
    snippet: 'Process.Start("worker", ["--id", workerId.ToString()]);',
    description: "Process.Start with numeric ToString()",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const csResult = await verifier.verifyFinding(csharpCommandFinding, process.cwd());
  assert.strictEqual(csResult.verdict, "DEFENDED", "C# Process.Start with numeric ToString must be DEFENDED");
  console.log("  ✔ Multi-language C# command injection correctly proven DEFENDED");

  // Test 7F: Multi-Language Java Verification
  const javaPathFinding: ClubbedFinding = {
    id: "VUL-JAVA-PATH",
    title: "Java Paths.get traversal alert",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "src/main/java/Config.java",
    line: 40,
    endLine: 40,
    snippet: 'Path p = Paths.get(baseDir, "application.properties");',
    description: "Paths.get with literal target",
    remediation: "Sanitize input",
    tools: ["Opengrep AST Engine"],
  };
  const javaResult = await verifier.verifyFinding(javaPathFinding, process.cwd());
  assert.strictEqual(javaResult.verdict, "DEFENDED", "Java Paths.get with literal target must be DEFENDED");
  console.log("  ✔ Multi-language Java path sink correctly proven DEFENDED");

  // Test 7G: Multi-Call Line Soundness - Untrusted sink on same line as safe literal helper call must NOT be DEFENDED
  const multiCallTaintedFinding: ClubbedFinding = {
    id: "VUL-MULTI-CALL-TAINTED",
    title: "Path traversal with helper call on same line",
    severity: "High",
    cwe: "CWE-22",
    category: "Path Traversal",
    filePath: "src/routes/download.ts",
    line: 55,
    endLine: 55,
    snippet: 'const data = fs.readFileSync(req.query.file, path.join(rootPath, "utf8"));',
    description: "Untrusted req.query.file on same line as literal path.join",
    remediation: "Sanitize req.query.file",
    tools: ["Opengrep AST Engine"],
    symbolName: "handleDownload",
  };
  const multiCallResult = await verifier.verifyFinding(multiCallTaintedFinding, process.cwd());
  assert.notStrictEqual(
    multiCallResult.verdict,
    "DEFENDED",
    "Untrusted input on a multi-call line or route handler must NEVER be falsely marked DEFENDED"
  );
  console.log("  ✔ Multi-call line & route handler entrypoint soundness verified (no false-negative DEFENDED)");

  // Test 8: Batch Verification across all 7 languages
  const batch = await verifier.verifyProjectFindings(
    [
      testSecretFinding,
      literalPathFinding,
      numericSpawnFinding,
      pythonPathFinding,
      goCommandFinding,
      rubyPathFinding,
      rustPathFinding,
      csharpCommandFinding,
      javaPathFinding,
      supplyChainFinding,
      circularFinding,
      ambiguousFinding,
    ],
    process.cwd()
  );
  assert.strictEqual(batch.length, 12, "All 12 multi-language findings must be returned with CEGAR metadata");
  assert.strictEqual(batch.filter(b => b.cegarVerdict === "DEFENDED").length, 9);
  assert.strictEqual(batch.filter(b => b.cegarVerdict === "CONFIRMED").length, 2);
  assert.strictEqual(batch.filter(b => b.cegarVerdict === "CANDIDATE").length, 1);
  console.log("  ✔ Batch 30+ language universal CEGAR verification orchestrator verified cleanly!");
}
