# Phase 2: Systematic Cloud Vulnerability Hunting

In Phase 2, investigate each of the 7 core vulnerability categories using CodeSentinel AST search and dataflow tracking.

---

## 1. Cloud IAM & Privilege Escalation (CWE-269, CWE-732)

### Hunting Strategy:
1. **Search for Wildcard Permissions**:
   - Inspect Terraform, CloudFormation, or CDK definitions for `"Action": "*"` or `"Action": ["s3:*", "iam:*", "dynamodb:*"]`.
   - Look for `"Resource": "*"` without strict condition keys.
2. **STS AssumeRole Trust Abuse**:
   - Check calls to `sts.assumeRole` or `sts.assumeRoleWithWebIdentity`.
   - Verify if an `ExternalId` or audience (`aud`) constraint is enforced to prevent the **Confused Deputy Problem**.
3. **Privilege Escalation Primitives**:
   - Can an unprivileged service role attach policies to itself (`iam:AttachRolePolicy`, `iam:PutRolePolicy`)?
   - Can it create access keys for privileged users (`iam:CreateAccessKey`)?
   - Can it pass roles to arbitrary serverless functions (`iam:PassRole` + `lambda:CreateFunction` / `ec2:RunInstances`)?

---

## 2. Data Exfiltration & Storage Insecurity (CWE-200, CWE-22, CWE-319)

### Hunting Strategy:
1. **Unsanitized Object Keys (Path Traversal to Cloud Storage)**:
   - Identify endpoints that take a filename or key from `req.query`, `req.params`, or `req.body` and pass it to S3/GCS:
     ```typescript
     // VULNERABLE PATTERN
     const fileKey = req.query.filename;
     await s3.send(new GetObjectCommand({ Bucket: "my-bucket", Key: fileKey }));
     ```
   - Use `codesentinel_find_path` from the HTTP parameter to the `GetObjectCommand` or `deleteObject` call.
   - Check if `path.basename()` or an allowlist is applied.
2. **Presigned URL Misconfigurations**:
   - Are presigned URLs generated without an explicit expiration timeout (`expiresIn: 3600`)?
   - Are PUT presigned URLs generated without enforcing `ContentType` or maximum payload size limits?
3. **Missing Encryption at Rest**:
   - Check bucket creation policies. Are KMS keys specified? Is `ServerSideEncryptionConfiguration` enabled?

---

## 3. Server-Side Request Forgery (SSRF) & Metadata Service Abuse (CWE-918)

### Hunting Strategy:
1. **Identify Outbound HTTP Requests**:
   - Search for `fetch(`, `axios.get(`, `axios.post(`, `http.request(`, `requests.get(`, `urllib.request(`.
2. **Trace Taint from Entrypoints**:
   - Use `codesentinel_find_path` between user-supplied parameters (e.g. `webhookUrl`, `avatarUrl`, `target`, `redirect`) and outbound HTTP clients.
3. **Check for Cloud Metadata API Defenses**:
   - Can an attacker point the URL to `http://169.254.169.254/latest/meta-data/` to dump AWS IAM credentials?
   - Can they target `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`?
   - Can they target `http://169.254.169.254/metadata/instance?api-version=2021-02-01`?
   - Check if private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`, `169.254.169.254`, `::1`) are blocked with a robust DNS-resolution guard to prevent DNS rebinding.

---

## 4. Serverless & Container Isolation Vulnerabilities (CWE-829, CWE-78)

### Hunting Strategy:
1. **Execution Sinks in Cloud Handlers**:
   - Search for `child_process.exec`, `execSync`, `spawn`, `subprocess.Popen`, `os.system` within Lambda handlers.
   - Use `codesentinel_find_path` from `event.body` or `event.queryStringParameters` to the command execution string.
2. **Global State Pollution**:
   - In serverless runtimes (AWS Lambda, Cloudflare Workers), variables declared in module scope persist across multiple warm invocations.
   - Check if user data, auth tokens, or tenant IDs are stored in module-level global variables:
     ```typescript
     // VULNERABLE: Global tenant leak across invocations
     let currentTenantId: string;
     export const handler = async (event) => {
       if (event.tenantId) currentTenantId = event.tenantId;
       // ...
     };
     ```
3. **Container Configurations**:
   - Inspect `Dockerfile`:
     * Is the container running as `USER root`?
     * Is `/var/run/docker.sock` mounted into the container?
     * Is the root filesystem writable instead of `read_only: true`?

---

## 5. Injection to Cloud Services & NoSQL (CWE-89, CWE-943)

### Hunting Strategy:
1. **DynamoDB FilterExpression Injection**:
   - Search for string concatenation in `FilterExpression` or `KeyConditionExpression`:
     ```typescript
     // VULNERABLE
     const params = {
       TableName: "Users",
       FilterExpression: `username = '${req.body.username}'` // Dangerous!
     };
     ```
   - Safe implementation requires `ExpressionAttributeValues` and `ExpressionAttributeNames`.
2. **Firestore / MongoDB Object Injection**:
   - Look for unvalidated query objects passed directly to database queries:
     ```typescript
     // VULNERABLE: $where or $regex injection
     db.collection("users").find(req.query);
     ```

---

## 6. Authentication, Token & Session Flaws (CWE-287, CWE-347, CWE-862)

### Hunting Strategy:
1. **JWT Signature Verification**:
   - Check if `jwt.decode()` is used instead of `jwt.verify()`.
   - Check if `algorithms: ['RS256']` is explicitly specified to prevent the **Algorithm Confusion Attack** (forcing HS256 with public key).
   - Check if expired tokens are accepted (`ignoreExpiration: true`).
2. **Broken Object Level Authorization (BOLA / IDOR)**:
   - Does an endpoint accept an `id` or `uuid` in the URL/body and immediately query or mutate the cloud resource without verifying that the authenticated user owns that resource?
   - Trace using `codesentinel_find_path` from `req.params.id` to the database query and verify if `userId == session.user.id` is checked.

---

## 7. Hardcoded Secrets & Cloud Credentials (CWE-798, CWE-200)

### Hunting Strategy:
1. **Credential Pattern Search**:
   - AWS Access Key ID: `AKIA[0-9A-Z]{16}`
   - AWS Secret Access Key: 40-character base64 string
   - GCP Service Account Key: `"type": "service_account"`, `"private_key": "-----BEGIN PRIVATE KEY-----"`
   - GitHub Token: `ghp_[A-Za-z0-9_]{36}`
   - Slack Webhook: `https://hooks.slack.com/services/T[0-9A-Z]+/B[0-9A-Z]+/[0-9A-Za-z]+`
2. **Environment Variable Exposure**:
   - Are `process.env` objects serialized and returned in error responses or `/debug` endpoints?
   - Are `.env` files included in the Docker build context without being listed in `.dockerignore`?
