# Phase 1: Attack Surface Reconnaissance & Trust Boundary Mapping

Reconnaissance is the foundation of any thorough cloud security audit. Before attempting to identify vulnerabilities, you must comprehensively discover and document the application's topology, cloud service touchpoints, and security perimeters.

---

## 1. Cloud Provider & SDK Detection

Search the codebase for cloud client initializations and configuration manifests.

### Detection Checklist:

- **Amazon Web Services (AWS)**:
  * TypeScript/Node: `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-iam`, `@aws-sdk/client-lambda`, `@aws-sdk/client-sts`, `aws-sdk`
  * Python: `boto3`, `botocore`, `aioboto3`
  * Go: `github.com/aws/aws-sdk-go-v2`, `github.com/aws/aws-sdk-go`
  * Java: `software.amazon.awssdk`, `com.amazonaws`
- **Google Cloud Platform (GCP)**:
  * Node: `@google-cloud/storage`, `@google-cloud/firestore`, `@google-cloud/secret-manager`
  * Python: `google-cloud-storage`, `google-cloud-firestore`
  * Go: `cloud.google.com/go/storage`, `google.golang.org/api`
- **Microsoft Azure**:
  * Node: `@azure/storage-blob`, `@azure/identity`, `@azure/cosmos`
  * Python: `azure-storage-blob`, `azure-identity`
- **Cloudflare**:
  * Workers runtime, KV bindings, R2 buckets, D1 databases, Durable Objects (`wrangler.toml`, `wrangler.json`)
- **Infrastructure as Code (IaC)**:
  * Terraform (`*.tf`, `*.tfvars`), CloudFormation/SAM (`template.yaml`), AWS CDK (`cdk.json`), Serverless Framework (`serverless.yml`), Kubernetes manifests (`*.yaml`).

Use `codesentinel_search_symbols` to search for:
- `S3Client`, `DynamoDBClient`, `boto3.client`, `StorageClient`, `BlobServiceClient`
- AWS Lambda handler functions (`handler`, `main`, `exports.handler`)

---

## 2. Entrypoint & Route Cataloging

Every point where external or untrusted data enters the application must be mapped.

### Entrypoint Types:

1. **HTTP / REST / GraphQL Endpoints**:
   - Express: `app.get()`, `app.post()`, `router.use()`
   - FastAPI: `@app.get()`, `@app.post()`, `@router.api_route()`
   - Spring Boot: `@GetMapping`, `@PostMapping`, `@RequestMapping`
   - Go Gin/Echo/Fiber: `r.GET()`, `r.POST()`
   - Next.js / Nuxt: `pages/api/*`, `app/api/*/route.ts`
2. **Asynchronous Message Consuming**:
   - SQS / RabbitMQ consumers, Kafka listeners (`@KafkaListener`, `sqs.receiveMessage`).
   - S3 / GCS Event notifications (`s3:ObjectCreated:*`).
3. **Serverless Function Triggers**:
   - API Gateway proxy events (`event.body`, `event.headers`, `event.queryStringParameters`).
   - CloudWatch Scheduled Events / EventBridge triggers.

---

## 3. Trust Boundary & Authentication Mapping

Identify every authentication and authorization checkpoint that separates public from privileged zones.

### Questions to Answer:

1. **Where does identity verification occur?**
   - Is there a centralized middleware (e.g. `authMiddleware`, `requireAuth`, `passport.authenticate`, `verifyToken`)?
   - Or is authentication applied ad-hoc per route?
2. **Are there unauthenticated routes?**
   - Check public routes: `/health`, `/metrics`, `/webhook`, `/login`, `/register`, `/public/*`.
   - Ensure sensitive operations (e.g. admin actions, cloud resource provisioning) are NOT accidentally mapped to public routes.
3. **Verify Middleware Enforcement via CodeSentinel**:
   - Use `codesentinel_call_hierarchy` on each controller function to inspect incoming callers.
   - Confirm that the router explicitly binds the auth guard before invoking the controller.

---

## 4. Cloud Sink Cataloging

Record all places where data or commands interact with cloud infrastructure:

| Sink Category | Examples | Security Implications |
| :--- | :--- | :--- |
| **Object Storage Sinks** | `s3.putObject`, `s3.getObject`, `s3.deleteObject`, `gcs.bucket().file().download()` | Path traversal on key, unauthorized deletion, public file upload. |
| **Cloud IAM Sinks** | `iam.attachRolePolicy`, `iam.createAccessKey`, `sts.assumeRole` | Privilege escalation, credential theft. |
| **Outbound Network Sinks**| `axios.get`, `fetch`, `requests.get`, `http.request` | SSRF, IMDS metadata extraction. |
| **Database Sinks** | `dynamodb.query`, `firestore.collection().where()` | NoSQL injection, unauthorized record reads. |
| **Execution Sinks** | `exec`, `spawn`, `eval`, `child_process` | Command injection in cloud runtime or Lambda container. |

---

## Deliverable from Phase 1

Compile an internal reconnaissance table listing:
- Total routes/entrypoints identified.
- Authentication status of each route.
- Cloud SDKs and resources utilized.
- High-risk sinks that require targeted dataflow tracing in Phase 2.
